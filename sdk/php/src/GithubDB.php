<?php

namespace GithubDB;

/**
 * GithubDB PHP Read SDK.
 *
 * Reads databases directly from GitHub raw CDN (or API with token),
 * decodes vectors, supports semantic search and query dispatch.
 */
class GithubDB
{
    private string $owner;
    private string $repo;
    private string $branch;
    private ?string $token;
    private $httpClient;
    private $embedder;

    /** @var array<string, array> Per-instance cache: db name → parsed JSON data */
    private array $cache = [];

    /**
     * @param string        $owner      GitHub owner (user or org).
     * @param string        $repo       Repository name (default: 'githubdb').
     * @param string        $branch     Branch name (default: 'main').
     * @param string|null   $token      GitHub personal access token (optional).
     * @param callable|null $httpClient HTTP client: (string $method, string $url, array $headers, ?string $body): array [int $status, string $body].
     * @param callable|null $embedder   Text embedder: (string $text): float[].
     */
    public function __construct(
        string $owner,
        string $repo = 'githubdb',
        string $branch = 'main',
        ?string $token = null,
        ?callable $httpClient = null,
        ?callable $embedder = null
    ) {
        $this->owner = $owner;
        $this->repo = $repo;
        $this->branch = $branch;
        $this->token = $token;
        $this->httpClient = $httpClient;
        $this->embedder = $embedder;
    }

    /**
     * Get a Table object for the given database and table name.
     *
     * Loads (and caches) the database JSON, merges shards if needed.
     *
     * @throws GithubDBException If database or table not found.
     */
    public function table(string $db, string $name): Table
    {
        $data = $this->loadDb($db);

        // Tables are keyed by name in the githubDB format.
        $tables = $data['tables'] ?? [];
        $tableData = $tables[$name] ?? null;

        if ($tableData === null) {
            throw new GithubDBException("Table '{$name}' not found in database '{$db}'");
        }

        $columns = $tableData['columns'] ?? [];
        $rows = $tableData['rows'] ?? [];

        // Merge shards
        if (!empty($tableData['shards'])) {
            foreach ($tableData['shards'] as $shardFile) {
                $shardData = $this->fetchFile("data/{$shardFile}", expectDatabase: false);
                $rows = array_merge($rows, $shardData['rows'] ?? []);
            }
        }

        return new Table($name, $columns, $rows, $this->embedder);
    }

    /**
     * Invalidate the cache for a database and re-fetch it on next access.
     */
    public function refresh(string $db): void
    {
        unset($this->cache[$db]);
        // Eagerly re-fetch
        $this->loadDb($db);
    }

    /**
     * Dispatch a SQL query via repository_dispatch and poll for results.
     *
     * Requires a token.
     *
     * @param string        $db       Database name.
     * @param string        $sql      SQL query string.
     * @param array         $params   Bound parameters.
     * @param int           $timeout  Timeout in seconds.
     * @param int           $interval Polling interval in seconds.
     * @param callable|null $sleep    Sleep callable (int $seconds): void. Default: sleep().
     * @return array Decoded JSON result.
     * @throws GithubDBException On missing token, dispatch error, or timeout.
     */
    public function query(
        string $db,
        string $sql,
        array $params = [],
        int $timeout = 120,
        int $interval = 3,
        ?callable $sleep = null
    ): array {
        if ($this->token === null) {
            throw new GithubDBException('A token is required to send queries');
        }

        $id = $this->generateUuid();
        $sleepFn = $sleep ?? static function (int $s): void { sleep($s); };

        // POST dispatch
        $dispatchUrl = "https://api.github.com/repos/{$this->owner}/{$this->repo}/dispatches";
        $payload = json_encode([
            'event_type' => 'query',
            'client_payload' => [
                'id' => $id,
                'db' => $db,
                'sql' => $sql,
                'params' => $params,
            ],
        ]);

        $headers = [
            'Accept: application/vnd.github+json',
            "Authorization: Bearer {$this->token}",
            'User-Agent: githubdb-sdk-php',
            'Content-Type: application/json',
        ];

        [$status] = $this->http('POST', $dispatchUrl, $headers, $payload);

        if ($status !== 204) {
            throw new GithubDBException("Query dispatch failed with HTTP {$status}");
        }

        // Poll for results
        $resultUrl = "https://raw.githubusercontent.com/{$this->owner}/{$this->repo}/{$this->branch}/results/{$id}.json";
        $elapsed = 0;

        while ($elapsed < $timeout) {
            $sleepFn($interval);
            $elapsed += $interval;

            [$resStatus, $resBody] = $this->http('GET', $resultUrl, [], null);

            if ($resStatus === 200) {
                return json_decode($resBody, true);
            }
            // 404 = not ready yet, keep polling
        }

        throw new GithubDBException(
            "Query timed out after {$timeout}s. Query id: {$id}"
        );
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /**
     * Load (and cache) a database JSON file.
     *
     * @throws GithubDBException If 404 or invalid format.
     */
    private function loadDb(string $db): array
    {
        if (isset($this->cache[$db])) {
            return $this->cache[$db];
        }

        $data = $this->fetchFile("data/{$db}.json");
        $this->cache[$db] = $data;
        return $data;
    }

    /**
     * Fetch a file from GitHub (raw CDN or API depending on token).
     *
     * @throws GithubDBException On 404 or invalid githubdb marker.
     */
    private function fetchFile(string $path, bool $expectDatabase = true): array
    {
        if ($this->token !== null) {
            $url = "https://api.github.com/repos/{$this->owner}/{$this->repo}/contents/{$path}?ref={$this->branch}";
            $headers = [
                'Accept: application/vnd.github.raw+json',
                "Authorization: Bearer {$this->token}",
                'User-Agent: githubdb-sdk-php',
            ];
        } else {
            $url = "https://raw.githubusercontent.com/{$this->owner}/{$this->repo}/{$this->branch}/{$path}";
            $headers = [];
        }

        [$status, $body] = $this->http('GET', $url, $headers, null);

        if ($status === 404) {
            // Determine resource type from path
            if (preg_match('/^data\/(.+?)\.json$/', $path, $m)) {
                $db = $m[1];
                throw new GithubDBException("Database '{$db}' not found");
            }
            throw new GithubDBException("File not found: {$path}");
        }

        if ($status !== 200) {
            throw new GithubDBException("HTTP {$status} fetching {$path}");
        }

        $data = json_decode($body, true);
        if (!is_array($data)) {
            throw new GithubDBException("Invalid JSON in {$path}");
        }

        // Validate githubdb marker (only for database base files, not shards)
        if ($expectDatabase && preg_match('/^data\/[^\/]+\.json$/', $path)) {
            if (($data['githubdb'] ?? null) !== 1) {
                throw new GithubDBException("File {$path} is not a valid githubDB database (missing githubdb: 1)");
            }
        }

        return $data;
    }

    /**
     * Execute an HTTP request using the injected client or default curl/file_get_contents.
     *
     * @param string      $method  HTTP method.
     * @param string      $url     Full URL.
     * @param string[]    $headers HTTP headers in "Name: Value" format.
     * @param string|null $body    Request body.
     * @return array [int $status, string $body]
     */
    private function http(string $method, string $url, array $headers, ?string $body): array
    {
        if ($this->httpClient !== null) {
            return ($this->httpClient)($method, $url, $headers, $body);
        }

        return $this->defaultHttp($method, $url, $headers, $body);
    }

    /**
     * Default HTTP implementation: curl if available, else file_get_contents.
     *
     * @return array [int $status, string $body]
     */
    private function defaultHttp(string $method, string $url, array $headers, ?string $body): array
    {
        if (extension_loaded('curl')) {
            return $this->curlHttp($method, $url, $headers, $body);
        }

        return $this->fileGetContentsHttp($method, $url, $headers, $body);
    }

    private function curlHttp(string $method, string $url, array $headers, ?string $body): array
    {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);

        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }

        $responseBody = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($responseBody === false) {
            return [0, ''];
        }

        return [$status, $responseBody];
    }

    private function fileGetContentsHttp(string $method, string $url, array $headers, ?string $body): array
    {
        $opts = [
            'http' => [
                'method' => $method,
                'header' => implode("\r\n", $headers),
                'ignore_errors' => true,
            ],
        ];

        if ($body !== null) {
            $opts['http']['content'] = $body;
        }

        $context = stream_context_create($opts);
        $responseBody = @file_get_contents($url, false, $context);

        if ($responseBody === false) {
            return [0, ''];
        }

        // Extract status from $http_response_header
        $status = 200;
        if (isset($http_response_header) && is_array($http_response_header)) {
            foreach ($http_response_header as $header) {
                if (preg_match('/^HTTP\/\d+(?:\.\d+)?\s+(\d+)/', $header, $m)) {
                    $status = (int)$m[1];
                }
            }
        }

        return [$status, $responseBody];
    }

    /**
     * Generate a random UUID v4.
     */
    private function generateUuid(): string
    {
        $data = random_bytes(16);

        // Set version (4) and variant bits
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
