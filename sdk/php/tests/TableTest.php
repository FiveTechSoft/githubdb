<?php

use GithubDB\Table;
use GithubDB\Vectors;
use GithubDB\GithubDBException;
use PHPUnit\Framework\TestCase;

class TableTest extends TestCase
{
    // -------------------------------------------------------------------------
    // Fixture helpers
    // -------------------------------------------------------------------------

    /**
     * Build a 3-dim vector table fixture.
     *
     * Rows: id, label, VECTOR(3)
     * Vectors chosen so similarity ordering is deterministic.
     *
     * Query vector [1, 0, 0]:
     *   row0: [1,0,0] → sim=1.0   (closest)
     *   row1: [0.7,0.7,0] → sim≈0.707
     *   row2: [0,1,0] → sim=0.0   (orthogonal)
     *   row3: null   → skipped
     */
    private function makeVectorTable(?callable $embedder = null): Table
    {
        $columns = ['id', 'label', 'VECTOR(3)'];
        $rows = [
            [1, 'alpha',  Vectors::encode([1.0, 0.0, 0.0])],
            [2, 'beta',   Vectors::encode([0.7, 0.7, 0.0])],
            [3, 'gamma',  Vectors::encode([0.0, 1.0, 0.0])],
            [4, 'null-v', null],  // null vector → skipped
        ];
        return new Table('items', $columns, $rows, $embedder);
    }

    /**
     * Regression: real githubDB column format is objects {name, type},
     * not plain strings. search() must detect VECTOR(n) in the TYPE and
     * objects() must key rows by NAME.
     */
    public function testRealColumnObjectFormat(): void
    {
        $columns = [
            ['name' => 'id', 'type' => 'INT'],
            ['name' => 'texto', 'type' => 'TEXT'],
            ['name' => 'embedding', 'type' => 'VECTOR(3)'],
        ];
        $rows = [
            [1, 'norte', Vectors::encode([1.0, 0.0, 0.0])],
            [2, 'este',  Vectors::encode([0.0, 1.0, 0.0])],
        ];
        $t = new Table('docs', $columns, $rows);

        $objs = $t->objects();
        $this->assertSame(['id' => 1, 'texto' => 'norte', 'embedding' => $rows[0][2]], $objs[0]);

        $hits = $t->search([1.0, 0.0, 0.0], limit: 1);
        $this->assertSame(1, $hits[0]['row']['id']);
        $this->assertEqualsWithDelta(1.0, $hits[0]['score'], 1e-6);
    }

    private function makeNoVectorTable(): Table
    {
        $columns = ['id', 'name'];
        $rows = [[1, 'Alice'], [2, 'Bob']];
        return new Table('plain', $columns, $rows);
    }

    // -------------------------------------------------------------------------
    // objects()
    // -------------------------------------------------------------------------

    public function testObjectsReturnsAssocRows(): void
    {
        $table = new Table('t', ['id', 'name'], [[1, 'Alice'], [2, 'Bob']]);
        $objs = $table->objects();

        $this->assertCount(2, $objs);
        $this->assertSame(['id' => 1, 'name' => 'Alice'], $objs[0]);
        $this->assertSame(['id' => 2, 'name' => 'Bob'],   $objs[1]);
    }

    // -------------------------------------------------------------------------
    // search with precomputed 3-dim vectors
    // -------------------------------------------------------------------------

    public function testSearchPrecomputedVectorOrder(): void
    {
        $table = $this->makeVectorTable();
        $query = [1.0, 0.0, 0.0];
        $results = $table->search($query, limit: 10);

        // null row is skipped → 3 results
        $this->assertCount(3, $results);
        $this->assertSame(1, $results[0]['row']['id']); // alpha: sim=1.0
        $this->assertSame(2, $results[1]['row']['id']); // beta:  sim≈0.707
        $this->assertSame(3, $results[2]['row']['id']); // gamma: sim=0.0
    }

    public function testSearchLimit(): void
    {
        $table = $this->makeVectorTable();
        $results = $table->search([1.0, 0.0, 0.0], limit: 2);

        $this->assertCount(2, $results);
        $this->assertSame(1, $results[0]['row']['id']);
        $this->assertSame(2, $results[1]['row']['id']);
    }

    public function testSearchWherePrefilter(): void
    {
        $table = $this->makeVectorTable();
        // Exclude id=1 (alpha) via where
        $results = $table->search(
            [1.0, 0.0, 0.0],
            limit: 10,
            where: fn(array $row) => $row['id'] !== 1
        );

        $this->assertCount(2, $results);
        $this->assertSame(2, $results[0]['row']['id']); // beta is now closest
    }

    public function testSearchNullVectorSkipped(): void
    {
        $table = $this->makeVectorTable();
        $results = $table->search([1.0, 0.0, 0.0], limit: 100);
        $ids = array_column(array_column($results, 'row'), 'id');
        $this->assertNotContains(4, $ids); // null-v row must not appear
    }

    // -------------------------------------------------------------------------
    // search with base64 query
    // -------------------------------------------------------------------------

    public function testSearchBase64Query(): void
    {
        $table = $this->makeVectorTable();
        $queryVec = [1.0, 0.0, 0.0];
        $base64Query = Vectors::encode($queryVec);

        $results = $table->search($base64Query, limit: 1);

        $this->assertCount(1, $results);
        $this->assertSame(1, $results[0]['row']['id']);
    }

    // -------------------------------------------------------------------------
    // dims mismatch
    // -------------------------------------------------------------------------

    public function testSearchDimsMismatchThrows(): void
    {
        $table = $this->makeVectorTable();
        // Pass a 2-dim query to a 3-dim table
        $this->expectException(GithubDBException::class);
        $this->expectExceptionMessageMatches('/expected 3, got 2/');
        $table->search([1.0, 0.0], limit: 10);
    }

    // -------------------------------------------------------------------------
    // no VECTOR column
    // -------------------------------------------------------------------------

    public function testSearchNoVectorColumnThrows(): void
    {
        $table = $this->makeNoVectorTable();
        $this->expectException(GithubDBException::class);
        $this->expectExceptionMessage("Table 'plain' has no VECTOR column");
        $table->search([1.0, 0.0, 0.0]);
    }

    // -------------------------------------------------------------------------
    // text search with injected fake embedder
    // -------------------------------------------------------------------------

    public function testSearchTextWithFakeEmbedder(): void
    {
        $fakeEmbedder = function (string $text): array {
            // Always return [0, 0, 1] for any text
            return [0.0, 0.0, 1.0];
        };

        $columns = ['id', 'label', 'VECTOR(3)'];
        $rows = [
            [1, 'a', Vectors::encode([0.0, 0.0, 1.0])], // sim=1.0 → closest
            [2, 'b', Vectors::encode([1.0, 0.0, 0.0])], // sim=0.0
        ];
        $table = new Table('items', $columns, $rows, $fakeEmbedder);

        $results = $table->search('hello world', limit: 2);

        $this->assertCount(2, $results);
        $this->assertSame(1, $results[0]['row']['id']);
        $this->assertEqualsWithDelta(1.0, $results[0]['score'], 1e-5);
    }

    // -------------------------------------------------------------------------
    // missing transformers-php → instructive exception
    // -------------------------------------------------------------------------

    public function testSearchTextWithoutTransformersThrows(): void
    {
        // No embedder injected; transformers-php not installed → instructive error
        $table = $this->makeVectorTable(null); // no embedder

        // Only test this if transformers-php is truly NOT installed
        $pipelineExists = function_exists('\\Codewithkyrian\\Transformers\\Pipelines\\pipeline')
            || class_exists('\\Codewithkyrian\\Transformers\\Pipelines\\Pipeline');

        if ($pipelineExists) {
            $this->markTestSkipped('codewithkyrian/transformers is installed; skipping missing-dep test.');
            return;
        }

        $this->expectException(GithubDBException::class);
        $this->expectExceptionMessageMatches('/composer require codewithkyrian\/transformers/');

        $table->search('some plain text query', limit: 5);
    }

    // -------------------------------------------------------------------------
    // score field present
    // -------------------------------------------------------------------------

    public function testSearchResultHasScoreField(): void
    {
        $table = $this->makeVectorTable();
        $results = $table->search([1.0, 0.0, 0.0], limit: 1);
        $this->assertArrayHasKey('score', $results[0]);
        $this->assertArrayHasKey('row', $results[0]);
    }

    // -------------------------------------------------------------------------
    // stable ties: rows with equal score preserve original order
    // -------------------------------------------------------------------------

    public function testSearchStableTies(): void
    {
        $columns = ['id', 'VECTOR(2)'];
        $rows = [
            [10, Vectors::encode([1.0, 0.0])],
            [20, Vectors::encode([1.0, 0.0])], // same vector → same score
            [30, Vectors::encode([1.0, 0.0])],
        ];
        $table = new Table('ties', $columns, $rows);

        $results = $table->search([1.0, 0.0], limit: 3);

        $this->assertSame(10, $results[0]['row']['id']);
        $this->assertSame(20, $results[1]['row']['id']);
        $this->assertSame(30, $results[2]['row']['id']);
    }
}
