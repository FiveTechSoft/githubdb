<?php

use GithubDB\GithubDB;
use GithubDB\GithubDBException;
use PHPUnit\Framework\TestCase;

class QueryTest extends TestCase
{
    // -------------------------------------------------------------------------
    // Fixture: fake HTTP client for query() tests
    // -------------------------------------------------------------------------

    /**
     * Build a sequence-based fake HTTP client.
     *
     * Each call returns the next response in $sequence.
     * sequence entry: [int $status, string|array $body]
     */
    private function makeSequentialClient(array $sequence, ?array &$callLog = null): callable
    {
        $idx = 0;
        return function (string $method, string $url, array $headers, ?string $body) use ($sequence, &$idx, &$callLog): array {
            if ($callLog !== null) {
                $callLog[] = ['method' => $method, 'url' => $url];
            }
            $entry = $sequence[$idx] ?? [404, ''];
            $idx++;
            [$status, $responseBody] = $entry;
            if (is_array($responseBody)) {
                $responseBody = json_encode($responseBody);
            }
            return [$status, $responseBody];
        };
    }

    // -------------------------------------------------------------------------
    // Happy path: 204 dispatch → 404 (not ready) → 404 → 200 with result
    // -------------------------------------------------------------------------

    public function testQueryHappyPath(): void
    {
        $resultPayload = ['result' => [['id' => 1, 'name' => 'Alice']]];

        $sleepCount = 0;
        $fakeSleep = function (int $s) use (&$sleepCount): void {
            $sleepCount++;
        };

        $sequence = [
            [204, ''],                  // POST dispatch → 204 No Content
            [404, ''],                  // first poll → not ready
            [404, ''],                  // second poll → not ready
            [200, $resultPayload],      // third poll → result
        ];

        $client = $this->makeSequentialClient($sequence);

        $gdb = new GithubDB('testowner', token: 'mytoken', httpClient: $client);
        $result = $gdb->query('mydb', 'SELECT * FROM users', [], 120, 3, $fakeSleep);

        $this->assertSame($resultPayload, $result);
        $this->assertSame(3, $sleepCount); // slept once per poll attempt
    }

    // -------------------------------------------------------------------------
    // No token → GithubDBException
    // -------------------------------------------------------------------------

    public function testQueryNoTokenThrows(): void
    {
        $gdb = new GithubDB('testowner'); // no token

        $this->expectException(GithubDBException::class);
        $this->expectExceptionMessage('A token is required to send queries');
        $gdb->query('mydb', 'SELECT 1');
    }

    // -------------------------------------------------------------------------
    // Timeout: error message contains query id
    // -------------------------------------------------------------------------

    public function testQueryTimeoutIncludesId(): void
    {
        $fakeSleep = function (int $s): void {
            // no-op
        };

        // Never return 200 — always 404
        $client = function (string $method, string $url, array $headers, ?string $body): array {
            return [204 === null ? 204 : ($method === 'POST' ? 204 : 404), ''];
        };

        // Smarter fake: POST→204, GET→404 always
        $client = function (string $method, string $url, array $headers, ?string $body): array {
            if ($method === 'POST') {
                return [204, ''];
            }
            return [404, ''];
        };

        $gdb = new GithubDB('testowner', token: 'mytoken', httpClient: $client);

        try {
            // Short timeout: 6s, interval 3s → 2 polls before timeout
            $gdb->query('mydb', 'SELECT 1', [], 6, 3, $fakeSleep);
            $this->fail('Expected GithubDBException for timeout');
        } catch (GithubDBException $e) {
            $message = $e->getMessage();
            $this->assertStringContainsString('timed out', strtolower($message));
            // Message must contain a UUID-like id
            $this->assertMatchesRegularExpression('/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i', $message);
        }
    }

    // -------------------------------------------------------------------------
    // Dispatch sends correct payload structure
    // -------------------------------------------------------------------------

    public function testQueryDispatchPayload(): void
    {
        $capturedBody = null;
        $capturedHeaders = [];

        $fakeSleep = function (int $s): void {};

        $client = function (string $method, string $url, array $headers, ?string $body) use (&$capturedBody, &$capturedHeaders): array {
            if ($method === 'POST') {
                $capturedBody = json_decode($body, true);
                $capturedHeaders = $headers;
                return [204, ''];
            }
            return [200, json_encode(['ok' => true])];
        };

        $gdb = new GithubDB('testowner', 'mygithubdb', token: 'mytoken', httpClient: $client);
        $gdb->query('mydb', 'SELECT * FROM t', ['p1' => 'v1'], 10, 1, $fakeSleep);

        $this->assertNotNull($capturedBody);
        $this->assertSame('query', $capturedBody['event_type']);
        $this->assertSame('mydb', $capturedBody['client_payload']['db']);
        $this->assertSame('SELECT * FROM t', $capturedBody['client_payload']['sql']);
        $this->assertSame(['p1' => 'v1'], $capturedBody['client_payload']['params']);
        $this->assertArrayHasKey('id', $capturedBody['client_payload']);
        // id should be UUID v4 format
        $this->assertMatchesRegularExpression(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/',
            $capturedBody['client_payload']['id']
        );
    }
}
