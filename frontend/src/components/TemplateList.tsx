import type { DataShape } from '../types';

interface Props {
  templates: DataShape[];
  /** Mock mode only: clears the simulated ui-templates/ cache. */
  onClear?: () => void;
}

export function TemplateList({ templates, onClear }: Props) {
  return (
    <div className="tpl">
      <span className="mono">ui-templates/</span>
      {templates.length ? (
        templates.map((k) => (
          <span key={k} className="chip mono">
            {k}/v1
          </span>
        ))
      ) : (
        <span>還沒有模板</span>
      )}
      {templates.length && onClear ? (
        <button type="button" className="btn small" onClick={onClear}>
          清空快取
        </button>
      ) : null}
    </div>
  );
}
