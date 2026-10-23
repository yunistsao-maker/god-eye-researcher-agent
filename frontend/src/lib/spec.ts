/*
 * Sub-UI spec helpers (contracts/ui-spec.schema.json). Pure functions, no DOM.
 * A spec never holds data, only "$.a.b" paths into the finding, rendered by whitelisted components.
 */
import { DATA_SHAPES, type Finding, type UiComponentName, type UiSpec } from '../types';

const PATH_RE = /^\$(\.[A-Za-z_][A-Za-z0-9_]{0,40}){1,4}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

interface ComponentRule {
  required: string[];
  optional: string[];
  paths: string[];
  fields: string[];
}

export const WHITELIST: Record<UiComponentName, ComponentRule> = {
  Compare: { required: ['columns', 'rows'], optional: ['emphasizeColumn'], paths: ['columns', 'rows'], fields: [] },
  Timeline: { required: ['items', 'label', 'text'], optional: [], paths: ['items'], fields: ['label', 'text'] },
  MetricBars: { required: ['items', 'label', 'value'], optional: ['unit'], paths: ['items'], fields: ['label', 'value', 'unit'] },
  KeyPoints: { required: ['items'], optional: [], paths: ['items'], fields: [] },
};

const TOP_KEYS = new Set(['specVersion', 'dataShape', 'title', 'root']);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const FAIL = 'spec 驗證失敗：';

/** Structural check against the whitelist. Returns a Traditional Chinese reason, or null when valid. */
export function validateSpec(spec: unknown): string | null {
  if (!isObj(spec)) return FAIL + '格式不正確';
  for (const k of Object.keys(spec)) if (!TOP_KEYS.has(k)) return FAIL + '不支援的欄位 ' + k;
  if (spec.specVersion !== 1) return FAIL + 'specVersion 必須是 1';
  if (typeof spec.dataShape !== 'string' || !(DATA_SHAPES as readonly string[]).includes(spec.dataShape)) return FAIL + 'dataShape 不正確';
  if (spec.title !== undefined && (typeof spec.title !== 'string' || spec.title.length > 80)) return FAIL + 'title 不正確';
  const root = spec.root;
  if (!isObj(root)) return FAIL + '缺少 root';
  for (const k of Object.keys(root)) if (k !== 'component' && k !== 'props') return FAIL + 'root 不支援欄位 ' + k;
  const name = root.component;
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(WHITELIST, name)) {
    return FAIL + '元件 ' + String(name) + ' 不在白名單內';
  }
  const rule = WHITELIST[name as UiComponentName];
  const props = root.props;
  if (!isObj(props)) return FAIL + name + ' 缺少 props';
  for (const k of Object.keys(props)) {
    if (!rule.required.includes(k) && !rule.optional.includes(k)) return FAIL + name + ' 不支援屬性 ' + k;
  }
  for (const k of rule.required) if (!(k in props)) return FAIL + name + ' 缺少屬性 ' + k;
  for (const k of rule.paths) {
    const v = props[k];
    if (typeof v !== 'string' || !PATH_RE.test(v)) return FAIL + '路徑 ' + String(v) + ' 格式不正確';
  }
  for (const k of rule.fields) {
    if (!(k in props)) continue;
    const v = props[k];
    if (typeof v !== 'string' || !FIELD_RE.test(v)) return FAIL + '欄位 ' + String(v) + ' 格式不正確';
  }
  if ('emphasizeColumn' in props) {
    const v = props.emphasizeColumn;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10) return FAIL + 'emphasizeColumn 必須是 0–10 的整數';
  }
  return null;
}

/** Resolves "$.a.b" against an object using own properties only. */
export function resolvePath(path: string, obj: unknown): unknown {
  if (!PATH_RE.test(path)) return undefined;
  const keys = path.slice(2).split('.');
  let cur: unknown = obj;
  for (const k of keys) {
    if (!isObj(cur) && !Array.isArray(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

const isText = (v: unknown) => typeof v === 'string' || typeof v === 'number';

/** Checks that the spec's paths resolve to data the component can draw. Null when renderable. */
export function specDataProblem(spec: UiSpec, finding: Finding): string | null {
  const p = spec.root.props as unknown as Record<string, unknown>;
  const bad = (path: unknown, what: string) => 'spec 資料不符：' + String(path) + ' ' + what;
  switch (spec.root.component) {
    case 'Compare': {
      const cols = resolvePath(String(p.columns), finding);
      const rows = resolvePath(String(p.rows), finding);
      if (!Array.isArray(cols) || !cols.every(isText)) return bad(p.columns, '不是文字陣列');
      if (!Array.isArray(rows) || !rows.every((r) => Array.isArray(r) && r.every(isText))) return bad(p.rows, '不是表格列');
      return null;
    }
    case 'Timeline':
    case 'MetricBars': {
      const items = resolvePath(String(p.items), finding);
      if (!Array.isArray(items) || !items.every(isObj)) return bad(p.items, '不是物件陣列');
      if (spec.root.component === 'MetricBars') {
        const vf = String(p.value);
        if (!items.every((it) => Number.isFinite(Number((it as Record<string, unknown>)[vf])))) return bad(p.items, '含有非數值');
      }
      return null;
    }
    case 'KeyPoints': {
      const items = resolvePath(String(p.items), finding);
      if (!Array.isArray(items) || !items.every(isText)) return bad(p.items, '不是文字陣列');
      return null;
    }
    default:
      return FAIL + '元件不在白名單內';
  }
}

/** Full check used by the reducer and the card: structure, then data (when the finding is known). */
export function specProblem(spec: unknown, finding?: Finding): string | null {
  const structural = validateSpec(spec);
  if (structural) return structural;
  return finding ? specDataProblem(spec as UiSpec, finding) : null;
}
