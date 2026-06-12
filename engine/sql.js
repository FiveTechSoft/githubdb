// engine/sql.js
import alasql from 'alasql';

// ---------------------------------------------------------------------------
// DDL: built-in parser (alasql doesn't know VECTOR(n))
// ---------------------------------------------------------------------------

const CREATE_RE = /^\s*CREATE\s+TABLE\s+([A-Za-z_]\w*)\s*\((.+)\)\s*;?\s*$/is;
const DROP_RE = /^\s*DROP\s+TABLE\s+([A-Za-z_]\w*)\s*;?\s*$/is;
const VALID_TYPE_RE = /^(INT|FLOAT|TEXT|BOOL|JSON|VECTOR\(\d+\))$/i;

function parseColumns(defText) {
  return defText.split(',').map(part => {
    const m = part.trim().match(/^([A-Za-z_]\w*)\s+(\w+(?:\(\d+\))?)$/);
    if (!m || !VALID_TYPE_RE.test(m[2])) {
      throw new Error(`Invalid column definition: '${part.trim()}'`);
    }
    return { name: m[1], type: m[2].toUpperCase() };
  });
}

// ---------------------------------------------------------------------------
// SQL pre-processor: bracket-quote alasql reserved words used as identifiers
// ---------------------------------------------------------------------------

// Words that alasql treats as reserved tokens but users commonly use as column
// names or aliases. We bracket-quote them unless followed by '(' (function call).
const ALASQL_COL_RESERVED = new Set([
  'total', 'partition', 'over', 'rows', 'interval', 'primary', 'foreign',
  'references', 'unique', 'default', 'constraint', 'check', 'cast', 'convert',
  'pivot', 'unpivot', 'rollup', 'cube', 'grouping', 'sets', 'percent', 'top',
  'fetch', 'only', 'escape', 'full', 'recursive', 'search', 'schema', 'class',
  'of', 'using', 'natural', 'corresponding', 'except', 'intersect', 'minus',
  'value', 'key', 'open', 'close', 'separator', 'at', 'star', 'literal',
  'row', 'column', 'columns', 'type', 'index', 'rank', 'mode', 'median',
  'variance', 'stdev', 'within', 'sample', 'seed', 'ties', 'breadth', 'depth',
  'range', 'preceding', 'following', 'current', 'unbounded',
]);

/**
 * Bracket-quote alasql reserved words that appear as identifiers (not function
 * calls) in user SQL, while leaving string literals and already-quoted
 * identifiers untouched.
 */
function quoteReservedIdentifiers(sql) {
  // Regex alternation (evaluated left-to-right):
  //   1. Single-quoted string literal   -> pass through unchanged
  //   2. Already bracket-quoted ident   -> pass through unchanged
  //   3. word possibly followed by '('  -> quote if reserved AND not a function call
  return sql.replace(/'(?:[^']|'')*'|\[([^\]]*)\]|([A-Za-z_]\w*)(\s*\()?/g,
    (match, _bracketContent, word, paren) => {
      if (_bracketContent !== undefined) return match; // [already_quoted]
      if (paren) return match;                         // funcName(
      if (!word) return match;
      if (ALASQL_COL_RESERVED.has(word.toLowerCase())) return `[${word}]`;
      return match;
    });
}

// ---------------------------------------------------------------------------
// Named parameters: :name -> positional ? (skip string literals)
// ---------------------------------------------------------------------------

// Convert :name parameters to alasql positional '?', skipping string literals.
function namedToPositional(sql, params) {
  const values = [];
  const out = sql.replace(/'(?:[^']|'')*'|:(\w+)/g, (match, name) => {
    if (name === undefined) return match; // quoted string: untouched
    if (!(name in params)) throw new Error(`Missing parameter :${name}`);
    values.push(params[name]);
    return '?';
  });
  return { sql: out, values };
}

// ---------------------------------------------------------------------------
// Row/object conversion helpers
// ---------------------------------------------------------------------------

function rowToObject(columns, row) {
  const obj = {};
  columns.forEach((c, i) => { obj[c.name] = row[i] ?? null; });
  return obj;
}

function objectToRow(columns, obj) {
  return columns.map(c => obj[c.name] ?? null);
}

/**
 * alasql stores INSERT INTO t VALUES (...) rows as arrays rather than objects.
 * Normalize them to objects using the known column schema.
 */
function fixArrayRows(data, columns) {
  return data.map(row => {
    if (Array.isArray(row)) {
      const obj = {};
      columns.forEach((col, i) => { obj[col.name] = row[i] ?? null; });
      return obj;
    }
    return row;
  });
}

// ---------------------------------------------------------------------------
// DML/SELECT via alasql
// ---------------------------------------------------------------------------

const MODIFYING_RE = /^\s*(INSERT|UPDATE|DELETE)\b/i;

async function runDml(db, sql, params, _options) {
  const adb = new alasql.Database();
  for (const [tname, table] of Object.entries(db.tables)) {
    adb.exec(`CREATE TABLE ${tname}`);
    adb.tables[tname].data = table.rows.map(r => rowToObject(table.columns, r));
  }

  const sqlQuoted = quoteReservedIdentifiers(sql);
  const { sql: positionalSql, values } = namedToPositional(sqlQuoted, params);
  const modifying = MODIFYING_RE.test(sql);
  const result = adb.exec(positionalSql, values);

  if (modifying) {
    for (const [tname, table] of Object.entries(db.tables)) {
      // Normalize any array rows that alasql created for INSERT ... VALUES (...)
      const normalizedData = fixArrayRows(adb.tables[tname].data, table.columns);
      table.rows = normalizedData.map(o => objectToRow(table.columns, o));
    }
    return {
      columns: [],
      rows: [],
      rowCount: typeof result === 'number' ? result : 0,
      modified: true,
    };
  }

  // SELECT path
  const objects = Array.isArray(result) ? result : [];
  const columns = objects.length > 0 ? Object.keys(objects[0]) : [];
  const rows = objects.map(o => columns.map(c => o[c] ?? null));
  return { columns, rows, rowCount: rows.length, modified: false };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function executeQuery(db, sql, params = {}, options = {}) {
  let m;
  if ((m = sql.match(CREATE_RE))) {
    const [, name, defText] = m;
    if (db.tables[name]) throw new Error(`Table '${name}' already exists`);
    db.tables[name] = { columns: parseColumns(defText), rows: [] };
    return { columns: [], rows: [], rowCount: 0, modified: true };
  }
  if ((m = sql.match(DROP_RE))) {
    const [, name] = m;
    if (!db.tables[name]) throw new Error(`Table '${name}' not found`);
    delete db.tables[name];
    return { columns: [], rows: [], rowCount: 0, modified: true };
  }
  return runDml(db, sql, params, options);
}
