/** Shown in place of a node's conversation while its prerequisites are weak. */
export function PrereqBanner(props: { text: string; goTo: { id: string; label: string }; nodeLabel: string; onGo(): void; onContinue(): void }) {
  return (
    <div className="messages">
      <div className="card">
        <b>These prerequisites aren't solid yet:</b> {props.text}.
        <div className="card-foot">
          <button className="btn btn-primary" onClick={props.onGo}>
            Go to {props.goTo.label}
          </button>
          <button className="btn btn-secondary" onClick={props.onContinue}>
            Continue anyway
          </button>
        </div>
      </div>
      <div className="muted">{props.nodeLabel}'s chat opens when you continue.</div>
    </div>
  )
}
