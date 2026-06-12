<?php

use GithubDB\GithubDB;
use GithubDB\GithubDBException;
use GithubDB\Vectors;
use PHPUnit\Framework\TestCase;

class GithubDBTest extends TestCase
{
    // -------------------------------------------------------------------------
    // Fixture helpers
    // -------------------------------------------------------------------------

    /**
     * Build a simple in-memory fixture database JSON.
     */
    private function makeSimpleDb(): array
    {
        return [
            'githubdb' => 1,
            'tables' => [
                [
                    'name' => 'users',
                    'columns' => ['id', 'name'],
                    'rows' => [
                        [1, 'Alice'],
                        [2, 'Bob'],
                    ],
                ],
            ],
        ];
    }

    /**
     * Build a sharded database fixture.
     * The main file has inline rows + a shard reference.
     */
    private function makeShardedDb(): array
    {
        return [
            'githubdb' => 1,
            'tables' => [
                [
                    'name' => 'items',
                    'columns' => ['id', 'value'],
                    'rows' => [
                        [1, 'inline-1'],
                        [2, 'inline-2'],
                    ],
                    'shards' => ['items_shard1.json'],
                ],
            ],
        ];
    }

    private function makeShardFile(): array
    {
        return [
            'rows' => [
                [3, 'shard-3'],
                [4, 'shard-4'],
            ],
        ];
    }

    /**
     * Create a fake httpClient that serves responses from a map keyed by URL.
     *
     * Map values: [int $status, string|array $body]
     * If body is array it is JSON-encoded automatically.
     */
    private function makeFakeClient(array $urlMap, ?array &$callLog = null): callable
    {
        return function (string $method, string $url, array $headers, ?string $body) use ($urlMap, &$callLog): array {
            if ($callLog !== null) {
                $callLog[] = ['method' => $method, 'url' => $url, 'headers' => $headers];
            }
            foreach ($urlMap as $pattern => $response) {
                if ($url === $pattern || fnmatch($pattern, $url)) {
                    [$status, $responseBody] = $response;
                    if (is_array($responseBody)) {
                        $responseBody = json_encode($responseBody);
                    }
                    return [$status, $responseBody];
                }
            }
            return [404, '{"message":"Not Found"}'];
        };
    }

    // -------------------------------------------------------------------------
    // Simple read: columns and rows
    // -------------------------------------------------------------------------

    public function testSimpleReadColumnsAndRows(): void
    {
        $db = $this->makeSimpleDb();
        $client = $this->makeFakeClient([
            'https://raw.githubusercontent.com/testowner/githubdb/main/data/mydb.json' => [200, $db],
        ]);

        $gdb = new GithubDB('testowner', httpClient: $client);
        $table = $gdb->table('mydb', 'users');

        $this->assertSame(['id', 'name'], $table->columns());
        $this->assertSame([[1, 'Alice'], [2, 'Bob']], $table->rows());
    }

    // -------------------------------------------------------------------------
    // 404 → Database not found
    // -------------------------------------------------------------------------

    public function test404ThrowsDatabaseNotFound(): void
    {
        $client = $this->makeFakeClient([]);

        $gdb = new GithubDB('testowner', httpClient: $client);

        $this->expectException(GithubDBException::class);
        $this->expectExceptionMessage("Database 'missing' not found");
        $gdb->table('missing', 'anything');
    }

    // -------------------------------------------------------------------------
    // Unknown table → Table not found in database
    // -------------------------------------------------------------------------

    public function testUnknownTableThrowsTableNotFound(): void
    {
        $db = $this->makeSimpleDb();
        $client = $this->makeFakeClient([
            'https://raw.githubusercontent.com/testowner/githubdb/main/data/mydb.json' => [200, $db],
        ]);

        $gdb = new GithubDB('testowner', httpClient: $client);

        $this->expectException(GithubDBException::class);
        $this->expectExceptionMessage("Table 'ghost' not found in database 'mydb'");
        $gdb->table('mydb', 'ghost');
    }

    // -------------------------------------------------------------------------
    // Sharded merge order
    // -------------------------------------------------------------------------

    public function testShardedMergeOrder(): void
    {
        $mainDb = $this->makeShardedDb();
        $shard = $this->makeShardFile();

        $client = $this->makeFakeClient([
            'https://raw.githubusercontent.com/testowner/githubdb/main/data/sharddb.json' => [200, $mainDb],
            'https://raw.githubusercontent.com/testowner/githubdb/main/data/items_shard1.json' => [200, $shard],
        ]);

        $gdb = new GithubDB('testowner', httpClient: $client);
        $table = $gdb->table('sharddb', 'items');
        $rows = $table->rows();

        // Inline rows first, then shard rows
        $this->assertCount(4, $rows);
        $this->assertSame([1, 'inline-1'], $rows[0]);
        $this->assertSame([2, 'inline-2'], $rows[1]);
        $this->assertSame([3, 'shard-3'],  $rows[2]);
        $this->assertSame([4, 'shard-4'],  $rows[3]);
    }

    // -------------------------------------------------------------------------
    // Cache: count client calls, then refresh
    // -------------------------------------------------------------------------

    public function testCacheReducesClientCalls(): void
    {
        $db = $this->makeSimpleDb();
        $callLog = [];
        $client = $this->makeFakeClient([
            'https://raw.githubusercontent.com/testowner/githubdb/main/data/mydb.json' => [200, $db],
        ], $callLog);

        $gdb = new GithubDB('testowner', httpClient: $client);

        $gdb->table('mydb', 'users');
        $gdb->table('mydb', 'users');

        // Should have fetched mydb.json only once
        $dbFetches = array_filter($callLog, fn($c) => str_contains($c['url'], 'data/mydb.json'));
        $this->assertCount(1, $dbFetches);
    }

    public function testRefreshInvalidatesCache(): void
    {
        $db = $this->makeSimpleDb();
        $callLog = [];
        $client = $this->makeFakeClient([
            'https://raw.githubusercontent.com/testowner/githubdb/main/data/mydb.json' => [200, $db],
        ], $callLog);

        $gdb = new GithubDB('testowner', httpClient: $client);

        $gdb->table('mydb', 'users');
        $gdb->refresh('mydb');
        $gdb->table('mydb', 'users');

        // refresh eagerly re-fetches, so 3 total fetches would occur:
        // 1st table(), refresh(), 2nd table() hits cache from refresh
        $dbFetches = array_filter($callLog, fn($c) => str_contains($c['url'], 'data/mydb.json'));
        $this->assertGreaterThanOrEqual(2, count($dbFetches));
    }

    // -------------------------------------------------------------------------
    // Token path: URL format and auth header
    // -------------------------------------------------------------------------

    public function testTokenPathUsesApiUrl(): void
    {
        $db = $this->makeSimpleDb();
        $callLog = [];

        $client = function (string $method, string $url, array $headers, ?string $body) use ($db, &$callLog): array {
            $callLog[] = ['url' => $url, 'headers' => $headers];
            // Accept API URL
            if (str_contains($url, 'api.github.com')) {
                return [200, json_encode($db)];
            }
            return [404, ''];
        };

        $gdb = new GithubDB('testowner', token: 'mytoken', httpClient: $client);
        $gdb->table('mydb', 'users');

        $this->assertNotEmpty($callLog);
        $firstCall = $callLog[0];

        // URL must be API format
        $this->assertStringContainsString('api.github.com', $firstCall['url']);
        $this->assertStringContainsString('contents/data/mydb.json', $firstCall['url']);
        $this->assertStringContainsString('ref=main', $firstCall['url']);

        // Headers must include Authorization and Accept: raw
        $headersStr = implode("\n", $firstCall['headers']);
        $this->assertStringContainsString('Authorization: Bearer mytoken', $headersStr);
        $this->assertStringContainsString('application/vnd.github.raw+json', $headersStr);
    }

    public function testNoTokenPathUsesRawUrl(): void
    {
        $db = $this->makeSimpleDb();
        $callLog = [];

        $client = function (string $method, string $url, array $headers, ?string $body) use ($db, &$callLog): array {
            $callLog[] = ['url' => $url, 'headers' => $headers];
            return [200, json_encode($db)];
        };

        $gdb = new GithubDB('testowner', httpClient: $client);
        $gdb->table('mydb', 'users');

        $this->assertNotEmpty($callLog);
        $this->assertStringContainsString('raw.githubusercontent.com', $callLog[0]['url']);
    }
}
