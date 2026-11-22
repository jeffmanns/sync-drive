import { useEffect, useState, type ReactNode } from "react";
import { fileCount, formatSize } from "../../format.ts";
import type {
  Action,
  CopiesState,
  DeletionsState,
  FailedFile,
  FileEntry,
  FlowState,
  PairingState,
  RefusedState,
  ResultState,
  Review,
  Section,
  StartState,
  SummaryState,
  Totals,
  UpdatingState,
} from "../view.ts";

/** Shows the step the flow is on. Every decision is made by the flow in the main process. */
export function App() {
  const [state, setState] = useState<FlowState | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const stop = window.syncDrive.onState(setState);
    void window.syncDrive.state().then(setState);
    return stop;
  }, []);

  /** Sends an action, with the buttons disabled until it is done, so nothing is sent twice. */
  const send = (action: Action) => {
    setBusy(true);
    void window.syncDrive.send(action).finally(() => setBusy(false));
  };

  if (state === undefined) return null;
  const props = { send, busy };
  return (
    <main data-step={state.step}>
      {(() => {
        switch (state.step) {
          case "pairing":
            return <PairingScreen state={state} {...props} />;
          case "start":
            return <StartScreen state={state} {...props} />;
          case "comparing":
            return <Waiting title="Comparing…" detail="Reading both drives. Nothing is written to either." />;
          case "refused":
            return <RefusedScreen state={state} {...props} />;
          case "copies":
            return <CopiesScreen state={state} {...props} />;
          case "deletions":
            return <DeletionsScreen state={state} {...props} />;
          case "summary":
            return <SummaryScreen state={state} {...props} />;
          case "updating":
            return <UpdatingScreen state={state} />;
          case "result":
            return <ResultScreen state={state} {...props} />;
        }
      })()}
    </main>
  );
}

interface ScreenProps<S> {
  state: S;
  send(action: Action): void;
  busy: boolean;
}

function PairingScreen({ state, send, busy }: ScreenProps<PairingState>) {
  const { replacing } = state;
  const ready = state.primary !== undefined && state.replica !== undefined && (replacing === undefined || replacing.confirmed);
  return (
    <>
      <h1>{replacing === undefined ? "Pair the drives" : "Re-pair the drives"}</h1>
      <p>Choose the top level of each drive, for example /Volumes/Photos. sync-drive recognises them by volume ID, so renaming a drive later does not matter.</p>
      <dl className="drives">
        <DriveChoice role="Primary" note="The everyday drive. sync-drive only ever reads it." path={state.primary} onChoose={() => send({ type: "choose", role: "primary" })} busy={busy} />
        <DriveChoice role="Replica" note="The drive that Updates make an exact copy of the Primary." path={state.replica} onChoose={() => send({ type: "choose", role: "replica" })} busy={busy} />
      </dl>
      {replacing !== undefined && (
        <label className="confirm">
          <input type="checkbox" checked={replacing.confirmed} disabled={busy} onChange={(event) => send({ type: "confirmReplace", confirmed: event.target.checked })} />
          {replacing.pairing === undefined
            ? "Replace the saved Pairing."
            : `Replace the saved Pairing of the Primary "${replacing.pairing.primary.name}" and the Replica "${replacing.pairing.replica.name}".`}
        </label>
      )}
      <Problem text={state.error} />
      <Buttons>
        {replacing?.pairing !== undefined && <button onClick={() => send({ type: "cancelRepair" })} disabled={busy}>Cancel</button>}
        <button className="primary" onClick={() => send({ type: "pair" })} disabled={busy || !ready}>Pair</button>
      </Buttons>
    </>
  );
}

function DriveChoice(props: { role: string; note: string; path: string | undefined; onChoose(): void; busy: boolean }) {
  return (
    <>
      <dt>{props.role}</dt>
      <dd>
        <span className="note">{props.note}</span>
        <span className="path">{props.path ?? "Not chosen yet"}</span>
        <button onClick={props.onChoose} disabled={props.busy}>Choose…</button>
      </dd>
    </>
  );
}

function StartScreen({ state, send, busy }: ScreenProps<StartState>) {
  const { primary, replica } = state.pairing;
  return (
    <>
      <h1>sync-drive</h1>
      <dl className="drives">
        <dt>Primary</dt>
        <dd>"{primary.name}" <span className="note">volume ID {primary.id}</span></dd>
        <dt>Replica</dt>
        <dd>"{replica.name}" <span className="note">volume ID {replica.id}</span></dd>
      </dl>
      <Problem text={state.error} />
      {state.notice !== undefined && <p className="notice">{state.notice}</p>}
      <Buttons>
        <button onClick={() => send({ type: "beginRepair" })} disabled={busy}>Re-pair…</button>
        <button className="primary" onClick={() => send({ type: "compare" })} disabled={busy}>Compare</button>
      </Buttons>
    </>
  );
}

function RefusedScreen({ state, send, busy }: ScreenProps<RefusedState>) {
  return (
    <>
      <h1>The Update is refused</h1>
      {state.reasons.map((reason) => <p key={reason} className="problem">{reason}</p>)}
      <p>Nothing was written to the Replica.</p>
      <Buttons>
        <button className="primary" onClick={() => send({ type: "restart" })} disabled={busy}>Back to Start</button>
      </Buttons>
    </>
  );
}

function CopiesScreen({ state, send, busy }: ScreenProps<CopiesState>) {
  const { review } = state;
  const copies = sum(review.new, review.changed);
  return (
    <>
      <Steps current="copies" review={review} />
      <h1>Copies</h1>
      <SectionList title="New" section={review.new} />
      <SectionList title="Changed" section={review.changed} />
      {copies.count > 0 ? (
        <label className="confirm">
          <input type="checkbox" checked={review.copiesApproved} disabled={busy} onChange={(event) => send({ type: "approveCopies", approved: event.target.checked })} />
          Copy all {describe(copies)} to the Replica.
        </label>
      ) : (
        <p>Nothing to copy.</p>
      )}
      <Buttons>
        <button onClick={() => send({ type: "restart" })} disabled={busy}>Start over</button>
        <button className="primary" onClick={() => send({ type: "next" })} disabled={busy}>Next</button>
      </Buttons>
    </>
  );
}

function DeletionsScreen({ state, send, busy }: ScreenProps<DeletionsState>) {
  const { review } = state;
  const held = review.holdingArea;
  return (
    <>
      <Steps current="deletions" review={review} />
      <h1>Deletions</h1>
      <p>These files are on the Replica but no longer on the Primary. Approving moves them into the Holding area on the Replica, keeping their folders.</p>
      <SectionList title="Deleted" section={review.deleted} />
      {/* Right before the deletions Approval, as in ADR 0006. */}
      {held.count > 0 && (
        <p className="warning">
          The Holding area on the Replica holds {describe(held)} from an earlier Update. Approving these deletions deletes{" "}
          {held.count === 1 ? "it" : "them"} permanently. To keep any of {held.count === 1 ? "it" : "them"}, copy {held.count === 1 ? "it" : "them"} back to the Primary first.
        </p>
      )}
      <label className="confirm">
        <input type="checkbox" checked={review.deletionsApproved} disabled={busy} onChange={(event) => send({ type: "approveDeletions", approved: event.target.checked })} />
        Move all {describe(review.deleted)} into the Holding area.
      </label>
      <Buttons>
        <button onClick={() => send({ type: "restart" })} disabled={busy}>Start over</button>
        <button onClick={() => send({ type: "back" })} disabled={busy}>Back</button>
        <button className="primary" onClick={() => send({ type: "next" })} disabled={busy}>Next</button>
      </Buttons>
    </>
  );
}

/** One section of the Report, grouped by folder. Every folder expands to its full file list. */
function SectionList({ title, section }: { title: string; section: Section }) {
  return (
    <section>
      <h2>{title}: {section.count === 0 ? "none" : describe(section)}</h2>
      {section.folders.map((group) => (
        <Expandable key={group.folder} label={group.folder === "" ? "(top level)" : `${group.folder}/`} totals={group}>
          <FileList files={group.files} inFolder={group.folder} />
        </Expandable>
      ))}
    </section>
  );
}

/** A row that shows its contents only once opened, so long lists cost nothing until needed. */
function Expandable({ label, totals, children }: { label: string; totals: Totals; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="folder">
      <button className="row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="name">{open ? "▾" : "▸"} {label}</span>
        <span className="count">{fileCount(totals.count)}</span>
        <span className="size">{formatSize(totals.totalSize)}</span>
      </button>
      {open && children}
    </div>
  );
}

function FileList({ files, inFolder }: { files: (FileEntry | FailedFile)[]; inFolder?: string }) {
  const strip = inFolder === undefined ? 0 : inFolder === "" ? 0 : inFolder.length + 1;
  return (
    <ul className="files">
      {files.map((file) => (
        <li key={file.path}>
          <span className="name">{file.path.slice(strip)}</span>
          <span className="size">{formatSize(file.size)}</span>
          {"reason" in file && <span className="reason">{file.reason}</span>}
        </li>
      ))}
    </ul>
  );
}

function SummaryScreen({ state, send, busy }: ScreenProps<SummaryState>) {
  const { copy, moveToHoldingArea, deleteFromHoldingArea, leaveOnReplica } = state.apply;
  const anything = copy.count + moveToHoldingArea.count > 0;
  const copiesToDo = state.review.new.count + state.review.changed.count > 0;
  return (
    <>
      <Steps current="summary" review={state.review} />
      <h1>Summary</h1>
      <p>Apply will:</p>
      <ul className="summary">
        {copy.count > 0
          ? <li>Copy {describe(copy)} from the Primary to the Replica.</li>
          : copiesToDo && <li>Copy nothing: the copies are not approved.</li>}
        {deleteFromHoldingArea.count > 0 && (
          <li className="warning">Permanently delete the {describe(deleteFromHoldingArea)} in the Holding area from an earlier Update.</li>
        )}
        {moveToHoldingArea.count > 0 && <li>Move {describe(moveToHoldingArea)} no longer on the Primary into the Holding area.</li>}
        {leaveOnReplica.count > 0 && <li>Leave the files only on the Replica where they are: {describe(leaveOnReplica)}. The deletions are not approved.</li>}
        <li>Write nothing to the Primary.</li>
      </ul>
      {anything ? <p className="note">Once Apply starts there is no going back.</p> : <p>Nothing is approved, so there is nothing to apply.</p>}
      <Buttons>
        <button onClick={() => send({ type: "restart" })} disabled={busy}>Start over</button>
        <button onClick={() => send({ type: "back" })} disabled={busy}>Back</button>
        <button className="primary" onClick={() => send({ type: "apply" })} disabled={busy || !anything}>Apply</button>
      </Buttons>
    </>
  );
}

function UpdatingScreen({ state }: { state: UpdatingState }) {
  const work = [
    ...(state.moving.count > 0 ? [`moving ${describe(state.moving)} into the Holding area`] : []),
    ...(state.copying.count > 0 ? [`copying ${describe(state.copying)} to the Replica`] : []),
  ].join(", then ");
  return <Waiting title="Updating…" detail={`${work.charAt(0).toUpperCase()}${work.slice(1)}. Keep both drives connected.`} />;
}

function ResultScreen({ state, send, busy }: ScreenProps<ResultState>) {
  const copied = totalsOf(state.copied);
  const moved = totalsOf(state.moved);
  const problems = state.error !== undefined || state.failed.length > 0 || state.notMoved.length > 0;
  return (
    <>
      <h1>{problems ? "Update finished with problems" : "Update done"}</h1>
      <Problem text={state.error === undefined ? undefined : `The Update stopped: ${state.error}`} />
      <section>
        <h2>Copied: {copied.count === 0 ? "none" : describe(copied)}</h2>
        {copied.count > 0 && (
          <Expandable label="Every copied file" totals={copied}>
            <FileList files={state.copied} />
          </Expandable>
        )}
      </section>
      {state.failed.length > 0 && (
        <section>
          <h2 className="problem">Not copied: {fileCount(state.failed.length)}</h2>
          <p>The Replica keeps its earlier version of each, if any.</p>
          <FileList files={state.failed} />
        </section>
      )}
      {moved.count > 0 && (
        <section>
          <h2>Moved into the Holding area: {describe(moved)}</h2>
          <Expandable label="Every moved file" totals={moved}>
            <FileList files={state.moved} />
          </Expandable>
          <p className="note">To restore one, copy it from the Holding area back to the Primary, into its original folder.</p>
        </section>
      )}
      {state.notMoved.length > 0 && (
        <section>
          <h2 className="problem">Not moved into the Holding area: {fileCount(state.notMoved.length)}</h2>
          <p>Each is still where it was on the Replica.</p>
          <FileList files={state.notMoved} />
        </section>
      )}
      {state.leftOnReplica.count > 0 && <p className="note">Left where they were, only on the Replica: {describe(state.leftOnReplica)}.</p>}
      <Buttons>
        <button className="primary" onClick={() => send({ type: "restart" })} disabled={busy}>Done</button>
      </Buttons>
    </>
  );
}

function Waiting({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="waiting">
      <h1>{title}</h1>
      <p>{detail}</p>
    </div>
  );
}

/** Where the review is, among the steps up to Apply. Deletions is there only when there is something to delete. */
function Steps({ current, review }: { current: "copies" | "deletions" | "summary"; review: Review }) {
  const steps = [
    { step: "copies", label: "Copies" },
    ...(review.deleted.count > 0 ? [{ step: "deletions", label: "Deletions" }] : []),
    { step: "summary", label: "Summary" },
  ];
  return (
    <ol className="steps">
      {steps.map(({ step, label }) => <li key={step} aria-current={current === step ? "step" : undefined}>{label}</li>)}
      <li>Apply</li>
    </ol>
  );
}

function Buttons({ children }: { children: ReactNode }) {
  return <div className="buttons">{children}</div>;
}

function Problem({ text }: { text: string | undefined }) {
  return text === undefined ? null : <p className="problem">{text}</p>;
}

/** "3 files (1.5 MB)". */
function describe(totals: Totals): string {
  return `${fileCount(totals.count)} (${formatSize(totals.totalSize)})`;
}

function totalsOf(files: FileEntry[]): Totals {
  return { count: files.length, totalSize: files.reduce((total, file) => total + file.size, 0) };
}

function sum(a: Totals, b: Totals): Totals {
  return { count: a.count + b.count, totalSize: a.totalSize + b.totalSize };
}
