# githubDB Read SDK — Especificación de diseño

**Fecha:** 2026-06-12
**Estado:** Aprobado (diseño validado en conversación)

## Resumen

SDKs cliente para el camino rápido de lectura de githubDB en **JavaScript** (Node + navegador), **Python** y **PHP**. Leen las bases de datos directamente del CDN raw de GitHub (sub-segundo, sin Action), descodifican vectores, embeben consultas localmente y calculan similitud en el cliente. Incluyen además una conveniencia de escritura (`query()`) que reutiliza el camino lento (`repository_dispatch` + polling).

## Objetivos

1. Lecturas y búsqueda semántica < 1 s contra cualquier fork de githubDB.
2. API idéntica en semántica en los tres lenguajes.
3. Dependencias de modelo **opcionales**: el SDK funciona sin ellas (vectores precomputados); con ellas, `search(texto)` embebe localmente.
4. Soporte de repos privados vía token (API contents con `Accept: raw`).
5. Sin red en los tests (HTTP y embeddings inyectables).

## No-objetivos

- Publicación en npm/PyPI/Packagist (instalación desde Git; publicar es paso posterior).
- Cache con TTL/invalidación automática (solo cache por instancia + `refresh()`).
- Escritura optimizada (la escritura sigue siendo el camino lento existente).

## Ubicación en el repo

```
sdk/
├─ js/        # paquete npm "githubdb-sdk" (ESM, Node 18+ y navegador)
│  ├─ package.json
│  ├─ src/{index.js, client.js, table.js, vectors.js, embed.js}
│  └─ test/*.test.js            # node:test, fetch inyectable
├─ python/    # paquete "githubdb-sdk" (módulo githubdb_sdk, Python 3.9+)
│  ├─ pyproject.toml            # extra opcional: [embed] -> sentence-transformers
│  ├─ githubdb_sdk/{__init__.py, client.py, table.py, vectors.py, embed.py}
│  └─ tests/test_*.py           # pytest, transport inyectable
└─ php/       # paquete composer "githubdb/sdk" (PHP 8.1+, PSR-4)
   ├─ composer.json             # sugiere codewithkyrian/transformers (opcional)
   ├─ src/{GithubDB.php, Table.php, Vectors.php, Embedder.php}
   └─ tests/*Test.php           # PHPUnit, cliente HTTP inyectable
```

## API (semántica común)

| Operación | JS | Python | PHP |
|---|---|---|---|
| Construir | `new GithubDB({owner, repo='githubdb', branch='main', token?, fetch?})` | `GithubDB(owner, repo="githubdb", branch="main", token=None, transport=None)` | `new GithubDB(owner, repo: 'githubdb', branch: 'main', token: null, httpClient: null)` |
| Leer tabla | `await gdb.table(db, name)` → `Table` | `gdb.table(db, name)` | `$gdb->table($db, $name)` |
| Columnas/filas | `t.columns`, `t.rows` | `t.columns`, `t.rows` | `$t->columns()`, `$t->rows()` |
| Filas como objetos | `t.objects()` | `t.objects()` (list[dict]) | `$t->objects()` (array assoc) |
| Búsqueda | `await t.search(textoOVector, {limit=10, where?})` | `t.search(q, limit=10, where=None)` | `$t->search($q, limit: 10, where: null)` |
| Refrescar | `await gdb.refresh(db)` | `gdb.refresh(db)` | `$gdb->refresh($db)` |
| Escritura (conveniencia) | `await gdb.query(db, sql, params?, {timeoutMs, intervalMs})` | `gdb.query(db, sql, params=None, timeout=120, interval=3)` | `$gdb->query($db, $sql, $params, timeout: 120, interval: 3)` |

Comportamiento de `search`:
- Entrada texto → embebe localmente (prefijo **`query: `**, modelo `multilingual-e5-small`, 384 dims) y busca por coseno.
- Entrada vector (array de números o base64) → busca directamente; valida dims contra `VECTOR(n)` de la columna.
- Usa la **primera** columna `VECTOR(n)` de la tabla; error claro si no hay ninguna.
- `where`: predicado sobre la fila-objeto, aplicado ANTES del ranking.
- Devuelve lista de `{row (objeto), score}` ordenada por score desc, limitada a `limit`.
- Empates: orden estable por posición original.

## Lectura de datos

1. `GET data/<db>.json`:
   - Sin token: `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/data/<db>.json`.
   - Con token: `https://api.github.com/repos/<owner>/<repo>/contents/data/<db>.json?ref=<branch>` con `Accept: application/vnd.github.raw+json` y `Authorization: Bearer`.
2. Validar `githubdb === 1`; 404 → error `Database '<db>' not found`.
3. Para cada tabla con `shards`: descargar shards (en paralelo en JS; secuencial está bien en Python/PHP) y concatenar `rows` tras las inline.
4. Cache por instancia: `table()` reutiliza la BD descargada; `refresh(db)` invalida y refetch.

## Embeddings locales por lenguaje

| | Dependencia (opcional) | Modelo | Activación |
|---|---|---|---|
| JS | `@huggingface/transformers` (peer opcional) | `Xenova/multilingual-e5-small` | import lazy en primera `search(texto)` |
| Python | `sentence-transformers` (extra `[embed]`) | `intfloat/multilingual-e5-small` | import lazy |
| PHP | `codewithkyrian/transformers` (suggest) | `Xenova/multilingual-e5-small` (ONNX) | lazy si la clase existe |

Sin la dependencia instalada, `search(texto)` lanza error instructivo con el comando de instalación exacto y la alternativa (pasar vector precomputado o usar `query()` con `EMBED()`); `search(vector)` funciona siempre. El embedder es inyectable en los tres SDKs (para tests y modelos propios).

## Decodificación de vectores (portable)

- Celda = base64 de float32 little-endian.
- JS: `atob`/`Uint8Array`/`DataView` o `Float32Array` sobre `ArrayBuffer` — sin `Buffer` (navegador).
- Python: `base64` + `struct`/`array('f')`; numpy NO requerido.
- PHP: `base64_decode` + `unpack('g*')` (float32 little-endian).

## `query()` (conveniencia de escritura)

Igual que `clients/`: genera UUID, `POST /repos/<owner>/<repo>/dispatches` con `{event_type:'query', client_payload:{id, db, sql, params}}` (requiere token), poll a `results/<id>.json` vía raw CDN cada `interval` hasta `timeout`, devuelve el JSON del resultado. Timeout → error con el id incluido (el resultado puede llegar tarde y consultarse a mano).

## Manejo de errores

| Caso | Comportamiento |
|---|---|
| BD inexistente (404) | `Database '<db>' not found` |
| Tabla inexistente | `Table '<t>' not found in database '<db>'` |
| Sin columna VECTOR al buscar | `Table '<t>' has no VECTOR column` |
| Dims incorrectas | `Vector dimension mismatch: expected N, got M` |
| Dependencia embed ausente | Error instructivo con comando de instalación |
| `query()` sin token | `A token is required to send queries` |
| `query()` timeout | Error con query id para consulta manual |

## Tests (sin red)

- HTTP inyectable: JS `options.fetch`; Python `transport` (callable url→(status,body)); PHP `httpClient` (callable).
- Fixtures compartidas conceptualmente: BD simple, BD con shards, BD con vectores (3 dims para legibilidad).
- Embedder fake inyectado para `search(texto)`.
- Cobertura mínima por SDK: lectura simple, merge de shards, cache+refresh, objects(), search por vector (orden correcto + limit + where), search por texto con embedder fake, dims mismatch, errores 404/tabla/no-vector/sin-dep, decode de vectores con valores conocidos, query() feliz + timeout (con transport fake).
- Runners: node:test / pytest / PHPUnit. Si PHP o Python no están disponibles en la máquina de desarrollo, instalar portable o reportar — los tests deben quedar ejecutables en CI.

## CI

Workflow nuevo `.github/workflows/sdk-tests.yml` (push/PR a sdk/**): matriz con Node 20, Python 3.11, PHP 8.2 ejecutando las tres suites. Sin dependencias de modelo (tests no embeben de verdad).

## Documentación

- `docs/sdk.md` en el sitio Pages: instalación desde Git + ejemplos de los 3 lenguajes (lectura, búsqueda, escritura), nota de dependencias opcionales de embedding.
- README: sección breve "SDKs" enlazando a la página.

## Decisiones tomadas

1. Tres lenguajes: JS (Node+navegador), Python, PHP — petición del usuario.
2. Mismo repo (`sdk/`), instalación desde Git; publicación en registries pospuesta.
3. Dependencias de modelo opcionales e inyectables; vector precomputado siempre soportado.
4. PHP usa transformers-php (ONNX) como opción local; sin él, vector-only.
5. `query()` incluido como conveniencia — un solo SDK cubre ambos caminos.
