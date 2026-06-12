<?php

namespace GithubDB;

/**
 * Represents a table within a githubDB database.
 */
class Table
{
    private array $columnList;
    private array $rowList;
    private string $name;
    private $embedder;
    /** @var string[] Column names, in order. */
    private array $colNames = [];
    /** @var string[] Column types, in order. */
    private array $colTypes = [];

    /**
     * @param string        $name     Table name.
     * @param array         $columns  Column definitions (array of column name strings or column objects).
     * @param array         $rows     Raw rows (array of arrays matching column order).
     * @param callable|null $embedder Injected embedder callable (string $text): float[].
     */
    public function __construct(
        string $name,
        array $columns,
        array $rows,
        ?callable $embedder = null
    ) {
        $this->name = $name;
        $this->columnList = $columns;
        $this->rowList = $rows;
        $this->embedder = $embedder;
        // githubDB column definitions are objects {name, type}; plain strings
        // are accepted too (treated as both name and type).
        foreach ($columns as $col) {
            if (is_array($col)) {
                $this->colNames[] = (string) ($col['name'] ?? '');
                $this->colTypes[] = (string) ($col['type'] ?? '');
            } else {
                $this->colNames[] = (string) $col;
                $this->colTypes[] = (string) $col;
            }
        }
    }

    /**
     * Return column names/definitions.
     */
    public function columns(): array
    {
        return $this->columnList;
    }

    /**
     * Return raw rows (arrays).
     */
    public function rows(): array
    {
        return $this->rowList;
    }

    /**
     * Return rows as associative arrays keyed by column name.
     *
     * @return array[]
     */
    public function objects(): array
    {
        $result = [];
        foreach ($this->rowList as $row) {
            $obj = [];
            foreach ($this->colNames as $i => $colName) {
                $obj[$colName] = $row[$i] ?? null;
            }
            $result[] = $obj;
        }
        return $result;
    }

    /**
     * Semantic search using cosine similarity on VECTOR columns.
     *
     * @param string|array|float[] $query  Text, float array, or base64 string.
     * @param int                  $limit  Max results to return.
     * @param callable|null        $where  Prefilter: receives assoc row, return true to include.
     * @return array[] Array of ['row' => assoc, 'score' => float] sorted desc by score.
     */
    public function search(string|array $query, int $limit = 10, ?callable $where = null): array
    {
        // Find the first VECTOR(n) column
        $vectorColIndex = null;
        $vectorDims = null;
        $vectorColName = null;

        foreach ($this->colTypes as $i => $colType) {
            if (preg_match('/^VECTOR\((\d+)\)$/', $colType, $m)) {
                $vectorColIndex = $i;
                $vectorDims = (int)$m[1];
                $vectorColName = $this->colNames[$i];
                break;
            }
        }

        if ($vectorColIndex === null) {
            throw new GithubDBException("Table '{$this->name}' has no VECTOR column");
        }

        // Resolve query to float vector
        $queryVec = $this->resolveQuery($query, $vectorDims);

        // Build scored results
        $scored = [];
        foreach ($this->rowList as $rowIndex => $row) {
            // Build assoc row
            $obj = [];
            foreach ($this->colNames as $i => $colName) {
                $obj[$colName] = $row[$i] ?? null;
            }

            // Apply prefilter
            if ($where !== null && !($where)($obj)) {
                continue;
            }

            // Skip null vector cells
            $cell = $row[$vectorColIndex] ?? null;
            if ($cell === null) {
                continue;
            }

            // Decode cell vector
            $cellVec = Vectors::toVector($cell, $vectorDims);

            $score = Vectors::cosineSim($queryVec, $cellVec);

            $scored[] = ['row' => $obj, 'score' => $score, '_idx' => $rowIndex];
        }

        // Sort descending by score, stable by original position (preserve _idx order for ties)
        usort($scored, function (array $a, array $b): int {
            $cmp = $b['score'] <=> $a['score'];
            if ($cmp !== 0) {
                return $cmp;
            }
            return $a['_idx'] <=> $b['_idx'];
        });

        // Remove internal index and limit
        $result = [];
        foreach (array_slice($scored, 0, $limit) as $item) {
            $result[] = ['row' => $item['row'], 'score' => $item['score']];
        }

        return $result;
    }

    /**
     * Resolve a query (string text, float array, or base64) to a float vector.
     *
     * @return float[]
     */
    private function resolveQuery(string|array $query, int $dims): array
    {
        if (is_array($query)) {
            return Vectors::toVector($query, $dims);
        }

        // String: check if it looks like base64-encoded binary (not plain text)
        // A base64-encoded float32 vector for $dims floats has exactly ceil($dims*4/3)*... chars
        // Heuristic: try to decode and check if result has exactly $dims floats
        $decoded = base64_decode($query, true);
        if ($decoded !== false && strlen($decoded) > 0 && strlen($decoded) % 4 === 0) {
            $numFloats = strlen($decoded) / 4;
            if ($numFloats === $dims) {
                // Treat as base64 vector
                return Vectors::decode($query, $dims);
            }
        }

        // Plain text: embed using embedder callable or built-in Embedder
        if ($this->embedder !== null) {
            $vec = ($this->embedder)($query);
            if (count($vec) !== $dims) {
                throw new GithubDBException(
                    "Vector dimension mismatch: expected {$dims}, got " . count($vec)
                );
            }
            return $vec;
        }

        $vec = Embedder::embed($query);
        if (count($vec) !== $dims) {
            throw new GithubDBException(
                "Vector dimension mismatch: expected {$dims}, got " . count($vec)
            );
        }
        return $vec;
    }
}
