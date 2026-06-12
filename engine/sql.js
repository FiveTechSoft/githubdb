// engine/sql.js
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

async function runDml() {
  throw new Error('not implemented yet');
}
