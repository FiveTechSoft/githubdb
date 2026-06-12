<?php

namespace GithubDB;

/**
 * Embedder: generates float32 vectors from text strings.
 *
 * Uses codewithkyrian/transformers (ONNX) when available,
 * otherwise throws an instructive GithubDBException.
 */
class Embedder
{
    private static ?object $pipeline = null;

    /**
     * Embed a query string to a float vector.
     *
     * @return float[]
     */
    public static function embed(string $text): array
    {
        // Check for the transformers-php pipeline function or class
        $pipelineExists = function_exists('\\Codewithkyrian\\Transformers\\Pipelines\\pipeline')
            || class_exists('\\Codewithkyrian\\Transformers\\Pipelines\\Pipeline');

        if (!$pipelineExists) {
            throw new GithubDBException(
                "Text search requires a local embedding model. " .
                "Install it with: composer require codewithkyrian/transformers\n" .
                "Alternatively, pass a pre-computed float vector array or base64 string to search()."
            );
        }

        if (self::$pipeline === null) {
            self::$pipeline = \Codewithkyrian\Transformers\Pipelines\pipeline(
                'feature-extraction',
                'Xenova/multilingual-e5-small'
            );
        }

        $pipe = self::$pipeline;
        $result = $pipe('query: ' . $text, pooling: 'mean', normalize: true);

        // Result may be nested array; flatten first level
        if (isset($result[0]) && is_array($result[0])) {
            $result = $result[0];
        }

        return array_values(array_map('floatval', $result));
    }
}
