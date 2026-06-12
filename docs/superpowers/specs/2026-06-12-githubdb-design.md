# githubDB — Especificación de diseño

**Fecha:** 2026-06-12
**Estado:** Borrador para revisión

## Resumen

githubDB es un repositorio GitHub autocontenido que se comporta como una base de datos SQL con soporte vectorial. Hacer fork del repositorio equivale a instalar tu propia base de datos: no requiere hosting, servidores ni coste alguno. El motor SQL se ejecuta dentro de GitHub Actions del propio fork, y los datos viven como ficheros JSON en el repositorio.

- Cada base de datos lógica es un fichero `data/<nombre>.json` (más shards si crece).
- Las queries se envían vía API REST de GitHub (`repository_dispatch`) en JSON, desde cualquier lenguaje.
- Los resultados se recogen como ficheros JSON vía `raw.githubusercontent.com`.
- Soporte nativo de columnas `VECTOR(n)` con auto-embeddings gratuitos (modelo local en la Action).

## Objetivos

1. **Fork = instalación.** Tras el fork, la base de datos funciona sin configurar nada.
2. **Agnóstico de lenguaje.** Cualquier cliente HTTP+JSON puede usarla (curl, Python, JS, Harbour...).
3. **SQL real.** CRUD completo + DDL: SELECT (WHERE, JOIN, GROUP BY, ORDER BY, LIMIT), INSERT, UPDATE, DELETE, CREATE TABLE, DROP TABLE.
4. **Optimizada para IA.** Columnas vectoriales, auto-embeddings gratuitos, búsqueda por similitud, y un camino de lectura rápida (<1s) para RAG.
5. **Coste cero.** Sin servicios externos de pago. Repos públicos: minutos de Actions ilimitados; privados: 2000 min/mes gratis.

## No-objetivos

- No es una base de datos para alta frecuencia ni baja latencia de escritura (cada escritura tarda 10–30 s).
- No hay transacciones multi-query ni sesiones.
- No hay control de acceso por fila/tabla: quien tiene token con acceso al repo, tiene acceso a todo.
- No se optimiza para datasets de varios GB (límites de GitHub).

## Arquitectura

### Estructura del repositorio

```
githubDB/
├─ data/                     # bases de datos del usuario
│  ├─ ejemplo.json           # BD "ejemplo" (fichero base)
│  ├─ ejemplo.001.json       # shard 1 (solo si la BD crece)
│  └─ ejemplo.002.json       # shard 2
├─ results/                  # resultados de queries (escritos por la Action)
│  └─ <query-id>.json
├─ engine/                   # motor SQL (Node.js)
│  ├─ run-query.js           # punto de entrada de la Action
│  ├─ sql.js                 # ejecución SQL (alasql) + funciones vectoriales
│  ├─ storage.js             # carga/guardado de BD, sharding, commits atómicos
│  ├─ vectors.js             # codificación base64-float32, similitud, normas
│  └─ embed.js               # auto-embeddings (transformers.js, modelo local)
├─ .github/workflows/
│  └─ query.yml              # workflow disparado por repository_dispatch
├─ clients/                  # ejemplos de cliente por lenguaje
│  ├─ curl.sh
│  ├─ python.py
│  └─ javascript.js
└─ README.md                 # documentación de uso completa
```

### Flujo de una query

1. El cliente genera un `id` único (p. ej. UUID) y envía:
   ```
   POST https://api.github.com/repos/<USER>/githubDB/dispatches
   Authorization: Bearer <token GitHub con scope repo>
   {
     "event_type": "query",
     "client_payload": {
       "id": "<uuid>",
       "db": "ejemplo",
       "sql": "SELECT * FROM clientes WHERE id > :min",
       "params": { "min": 5 }
     }
   }
   ```
2. GitHub dispara el workflow `query.yml`.
3. `run-query.js` carga `data/ejemplo.json` (+ shards), ejecuta el SQL con alasql.
4. Si el SQL modifica datos, escribe los ficheros de datos afectados.
5. Escribe `results/<id>.json` con el resultado.
6. Commit atómico (Git Trees API o un único commit con todos los ficheros) y push.
7. El cliente hace polling de
   `https://raw.githubusercontent.com/<USER>/githubDB/main/results/<id>.json`
   hasta obtenerlo (intervalo recomendado 3 s, timeout recomendado 120 s).

### Formato de resultado

```json
{
  "ok": true,
  "id": "<uuid>",
  "rowCount": 2,
  "columns": ["id", "nombre"],
  "rows": [[1, "Ana"], [2, "Luis"]],
  "elapsedMs": 840
}
```

En caso de error:

```json
{ "ok": false, "id": "<uuid>", "error": "Table 'clientes' not found in database 'ejemplo'" }
```

Errores siempre producen fichero de resultado: el cliente nunca se queda esperando indefinidamente por un SQL inválido.

### Concurrencia

> **Revisado 2026-06-12 tras pruebas de estrés E2E.** El diseño original usaba un
> `concurrency.group` por BD asumiendo que las queries encoladas esperaban. Falso:
> GitHub mantiene como máximo 1 run en ejecución + 1 pendiente por grupo y **cancela**
> el resto (3 de 5 INSERTs simultáneos se perdieron en la prueba). Se eliminó el grupo.

Todas las queries se ejecutan como runs paralelos y se serializan vía Git: cada run
commitea y hace push; si el push falla por carrera (otro commit entró antes), el motor
hace reset, pull de los datos frescos, **re-ejecuta la query** y reintenta el push,
hasta 5 intentos con backoff aleatorio. Ninguna query se descarta en silencio. Bajo
contención extrema un run puede agotar los 5 intentos: el run queda marcado como
fallido y la query puede reenviarse.

### Limpieza de resultados

Al final de cada ejecución, la Action borra de `results/` los ficheros con más de 1 hora de antigüedad (mismo commit).

## Formato de datos

### Fichero base de una BD

```json
{
  "githubdb": 1,
  "tables": {
    "clientes": {
      "columns": [
        { "name": "id", "type": "INT" },
        { "name": "nombre", "type": "TEXT" },
        { "name": "email", "type": "TEXT" }
      ],
      "rows": [
        [1, "Ana", "ana@mail.com"],
        [2, "Luis", "luis@mail.com"]
      ]
    },
    "docs": {
      "columns": [
        { "name": "id", "type": "INT" },
        { "name": "texto", "type": "TEXT" },
        { "name": "embedding", "type": "VECTOR(384)" }
      ],
      "embed_from": "texto",
      "shards": ["ejemplo.001.json", "ejemplo.002.json"],
      "rows": []
    }
  }
}
```

- `githubdb: 1` — versión del formato, para migraciones futuras.
- Tipos: `INT`, `FLOAT`, `TEXT`, `BOOL`, `JSON`, `VECTOR(n)`. Los tipos son orientativos (validación laxa estilo SQLite), salvo `VECTOR(n)` que sí valida dimensiones.
- Tablas pequeñas guardan filas inline (`rows`). Tablas grandes usan `shards`.

### Sharding

- Umbral: si al guardar, un fichero superaría **40 MB**, el motor mueve filas a un shard nuevo (`<bd>.NNN.json`).
- Un shard contiene `{ "table": "docs", "rows": [...] }`.
- El fichero base mantiene el manifest (`shards`) por tabla.
- Lectura: el motor concatena `rows` inline + filas de todos los shards de la tabla. Transparente para el SQL.
- Escritura: solo se reescriben los ficheros afectados; todos los cambios van en un único commit.
- Límites documentados: GitHub avisa a 50 MB y rechaza ficheros >100 MB; repos recomendados <1 GB (límite práctico ~5 GB).

## Soporte vectorial

### Almacenamiento

- Tipo `VECTOR(n)`: el valor de la celda es un string base64 de `n` float32 (little-endian).
- 384 dims ≈ 2 KB por vector (frente a ~3,5 KB como array JSON de texto).
- Los vectores no son legibles por humanos; se asume (los diffs de embeddings no aportan nada).

### Funciones SQL vectoriales

Registradas como funciones custom en alasql:

| Función | Descripción |
|---|---|
| `COSINE_SIM(col, v)` | Similitud coseno entre columna vector y vector `v` |
| `DOT_PRODUCT(col, v)` | Producto escalar |
| `EUCLIDEAN(col, v)` | Distancia euclídea |
| `EMBED(texto)` | Genera embedding del texto con el modelo local (384 dims) |

`v` puede ser: un parámetro (`:vec`, como base64 o array JSON), o `EMBED('...')`.

Ejemplo de búsqueda semántica con filtro relacional:

```sql
SELECT id, texto, COSINE_SIM(embedding, EMBED('factura impagada')) AS score
FROM docs
WHERE categoria = 'contabilidad'
ORDER BY score DESC
LIMIT 10
```

### Auto-embeddings (gratis, sin configuración)

- En `INSERT`/`UPDATE`, si una columna `VECTOR(384)` queda a `NULL` y la tabla declara `"embed_from": "<columna_texto>"` en sus metadatos, la Action genera el embedding automáticamente desde esa columna de texto.
- Modelo: `multilingual-e5-small` (384 dims, buen soporte de español) vía transformers.js/ONNX, ejecutado en el runner.
- El modelo se cachea con `actions/cache`: primera ejecución lo descarga (~120 MB), las siguientes cargan en segundos.
- Sin API keys, sin secretos, sin coste.

### Override con embeddings propios

El cliente puede enviar su propio vector (cualquier modelo, p. ej. OpenAI con `VECTOR(1536)`). Si el valor llega no nulo, se respeta y no se auto-embebe. La validación comprueba que las dimensiones coincidan con el tipo declarado.

### Búsqueda

- Fuerza bruta con normas precalculadas en memoria. ~100k vectores × 384 dims se resuelve en menos de 1 s en el runner. Sin índices HNSW (innecesario a esta escala).

### Camino rápido de lectura para RAG (<1 s, sin Action)

Para agentes de IA que necesitan lecturas rápidas:

1. El cliente lee `data/<bd>.json` (+ shards listados en el manifest) directamente de `raw.githubusercontent.com` — sin Action, latencia de CDN.
2. Embebe la consulta localmente (transformers.js corre en Node y navegador, mismo modelo, gratis) o con su propio modelo.
3. Calcula la similitud en el cliente.

Los ejemplos de `clients/` incluyen este patrón. Las escrituras siempre van por Action.

## Manejo de errores

| Situación | Comportamiento |
|---|---|
| SQL inválido | `results/<id>.json` con `ok:false` y mensaje del parser |
| BD inexistente | `ok:false`, `error: "Database '<x>' not found"` |
| Dimensiones de vector incorrectas | `ok:false` con dimensiones esperadas/recibidas |
| Fichero >100 MB pese a sharding (fila gigante) | `ok:false`, sin commit de datos |
| Carrera de push | Reintento ×3 con pull; luego `ok:false` |
| Payload sin `id` | Workflow termina sin resultado (no hay dónde escribirlo); documentado |

Principio: toda query con `id` válido termina produciendo un fichero de resultado, con `ok:true` o `ok:false`.

## Seguridad

- El token GitHub del cliente necesita scope `repo` (o fine-grained con `contents:write` + `metadata:read`) sobre el fork.
- El SQL se ejecuta con alasql sobre datos en memoria dentro del runner: sin acceso a shell ni eval de JS arbitrario. Aun así, el workflow limita permisos (`permissions: contents: write` únicamente).
- En repos públicos los datos son legibles por cualquiera. El README lo advierte de forma destacada y recomienda repos privados para datos sensibles.

## Pruebas

- **Unitarias (engine/):** SQL CRUD+DDL, codificación/decodificación de vectores, similitud (valores conocidos), sharding (split al superar umbral, lectura multi-shard), auto-embed (con modelo mockeado), parámetros `:param`.
- **Integración local:** ejecutar `run-query.js` contra un directorio `data/` de fixture, sin GitHub, verificando ficheros de datos y resultado.
- **End-to-end (manual/CI):** dispatch real contra el repo, polling del resultado.
- Framework: Node test runner nativo (`node:test`), sin dependencias extra.

## Limitaciones documentadas (README)

- Latencia por query vía Action: 10–30 s.
- Rate limits de la API GitHub (~5000 req/h con token).
- Tamaño práctico: cientos de MB por repo.
- Sin transacciones multi-query.
- Repos públicos = datos públicos.

## Decisiones tomadas (registro)

1. **API REST JSON** sobre librería/CLI — usable desde cualquier lenguaje.
2. **JSON** como formato de datos (no SQLite binario, no CSV) — legible, diffeable, "1 fichero = 1 BD".
3. **Fork = instalación**, motor en **GitHub Actions** — cero hosting, cero coste; se acepta la latencia.
4. **CRUD completo + DDL** con alasql.
5. **Sharding automático** a 40 MB — el principio pasa a "1 fichero base + N shards = 1 BD".
6. **Vectores base64-float32** inline en JSON.
7. **Auto-embeddings con modelo local en la Action** (multilingual-e5-small, 384 dims) + override con vectores del cliente.
