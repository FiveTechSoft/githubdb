<?php

/**
 * Simple PSR-4 autoloader for GithubDB SDK.
 * Works without composer — just require this file.
 */

spl_autoload_register(function (string $class): void {
    $prefix = 'GithubDB\\';
    $baseDir = __DIR__ . '/';

    $len = strlen($prefix);
    if (strncmp($prefix, $class, $len) !== 0) {
        return;
    }

    $relativeClass = substr($class, $len);
    $file = $baseDir . str_replace('\\', '/', $relativeClass) . '.php';

    if (file_exists($file)) {
        require $file;
    }
});
