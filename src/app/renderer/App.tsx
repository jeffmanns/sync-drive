import { useEffect, useState, type ReactNode } from "react";
import { describeFiles as describe, fileCount, formatSize, itemCount } from "../../format.ts";
import { canOverrideSafetyStop, comparingBar, freeSpaceExplanation, holdingAreaReminder, lastUpdatedLines, notRecordedWarning, onlyFolderDeletionsWarning, onlyFolderNote, reviewSteps, safetyStopExplanation, totalsOf, totalsOfFiles, totalsOfMoves, updatingBar, updatingLines, writesAnything } from "../view.ts";
import type {
  Action,
  AnomaliesState,
  ContentMismatch,
  CopiesState,
  DeletionsState,
  FailedFile,
  FailedMove,
  FileEntry,
  FlowState,
  MismatchChoice,
  Move,
  MovesSection,
  MovesState,
  PairingState,
  ProgressBar,
  RefusedState,
  ResultState,
  Review,
  ReviewStep,
  SafetyStopRefusal,
  Section,
  StartState,
  SummaryState,
  Totals,
  Unreadable,
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
            return (
              <>
                <Waiting
                  title={state.deep ? "Comparing, with Deep verify…" : "Comparing…"}
                  detail={state.deep ? "Reading both drives, every file in full. Nothing is written to either." : "Reading both drives. Nothing is written to either."}
                />
                <Bar bar={comparingBar(state.progress, state.deep)} />
              </>
            );
          case "refused":
            return <RefusedScreen state={state} {...props} />;
          case "copies":
            return <CopiesScreen state={state} {...props} />;
          case "anomalies":
            return <AnomaliesScreen state={state} {...props} />;
          case "moves":
            return <MovesScreen state={state} {...props} />;
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
  const { replacing, summary, waiting } = state;
  const ready = summary !== undefined && (replacing === undefined || replacing.confirmed);
  return (
    <>
      <h1>{replacing === undefined ? "Pair the drives" : "Re-pair the drives"}</h1>
      <p>
        Connect the Primary and the Replica, and nothing else, then pick which one is the Primary. sync-drive lists external drives
        and mounted disk images, and recognises them by volume ID, so renaming a drive later does not matter.
      </p>
      {state.drives.length > 0 && (
        <ul className="candidates">
          {state.drives.map((drive) => (
            <li key={drive.mountPoint}>
              <label>
                {waiting === undefined && (
                  <input
                    type="radio"
                    name="primary"
                    checked={summary?.primary.id === drive.id}
                    disabled={busy}
                    onChange={() => send({ type: "choosePrimary", id: drive.id })}
                  />
                )}
                <span className="name">"{drive.name}"</span>
                <span className="size">{formatSize(drive.size)}</span>
                <span className="note">volume ID {drive.id}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {waiting !== undefined ? <p className="notice">{waiting}</p> : summary === undefined && <p className="notice">Pick the drive that is the Primary.</p>}
      {summary !== undefined && (
        <>
          <h2>The Pairing to save</h2>
          <dl className="drives">
            <dt>Primary</dt>
            <dd>
              "{summary.primary.name}" <span className="note">volume ID {summary.primary.id}. The everyday drive: sync-drive only ever reads it.</span>
            </dd>
            <dt>Replica</dt>
            <dd>
              "{summary.replica.name}" <span className="note">volume ID {summary.replica.id}. Updates make it an exact copy of the Primary.</span>
            </dd>
          </dl>
        </>
      )}
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
        <button onClick={() => send({ type: "lookAgain" })} disabled={busy}>Look again</button>
        <button className="primary" onClick={() => send({ type: "pair" })} disabled={busy || !ready}>Save Pairing</button>
      </Buttons>
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
      {state.lastUpdated !== undefined && (
        <section className="last-updated">
          {lastUpdatedLines(state.lastUpdated, new Date()).map((line) => <p key={line}>{line}</p>)}
        </section>
      )}
      <OnlyFolder state={state} send={send} busy={busy} />
      <section className="deep-verify">
        <h2>How to compare</h2>
        <label className="confirm">
          <input type="checkbox" checked={state.deep} disabled={busy} onChange={(event) => send({ type: "deepVerify", on: event.target.checked })} />
          Deep verify: also read every file in full on both drives, and compare their checksums.
        </label>
        <p className="note">
          Catches damage on the Replica that sizes and dates do not show. It reads both drives in full, so it takes much longer than a Quick
          compare, which judges files by size and date alone.
        </p>
      </section>
      <ExclusionsList state={state} send={send} busy={busy} />
      <Problem text={state.error} />
      {state.notice !== undefined && <p className="notice">{state.notice}</p>}
      <Buttons>
        <button onClick={() => send({ type: "beginRepair" })} disabled={busy}>Re-pair…</button>
        <button className="primary" onClick={() => send({ type: "compare" })} disabled={busy}>Compare</button>
      </Buttons>
    </>
  );
}

/** Which part of the drive the next run compares: the whole drive, or one folder chosen on the Primary. */
function OnlyFolder({ state, send, busy }: ScreenProps<StartState>) {
  return (
    <section className="only-folder">
      <h2>What to compare</h2>
      {state.only === undefined ? (
        <p>The whole drive. To start with a small part of it, limit the run to one folder.</p>
      ) : (
        <p>Only the folder <strong>"{state.only}"</strong>. Nothing outside it is compared, copied, moved or deleted.</p>
      )}
      <Buttons>
        <button onClick={() => send({ type: "chooseOnlyFolder" })} disabled={busy}>
          {state.only === undefined ? "Limit to one folder…" : "Choose another folder…"}
        </button>
        {state.only !== undefined && <button onClick={() => send({ type: "wholeDrive" })} disabled={busy}>Compare the whole drive</button>}
      </Buttons>
    </section>
  );
}

/** The note on the review steps, the Summary and the Result when the run is limited to one folder. */
function OnlyFolderNote({ only }: { only: string | undefined }) {
  return only === undefined ? null : <p className="warning">{onlyFolderNote(only)}</p>;
}

/**
 * The owner's Exclusions, with a field to add a pattern and a Remove button on each. What is typed
 * stays here until sent; the flow checks it, and clears it from the field only once it is saved.
 */
function ExclusionsList({ state, send, busy }: ScreenProps<StartState>) {
  const [typed, setTyped] = useState("");
  const { exclusions } = state;
  // Cleared once the flow has saved what was typed; kept, with the problem shown, when it was refused.
  useEffect(() => {
    if (state.exclusionProblem === undefined) setTyped("");
  }, [exclusions, state.exclusionProblem]);
  return (
    <section className="exclusions">
      <h2>Exclusions</h2>
      <p className="note">
        Left out of every comparison, on both drives: never copied, moved or deleted. A name such as <span className="path">*.tmp</span> or{" "}
        <span className="path">node_modules</span> matches in any folder; a path such as <span className="path">Movies/Cache</span> starts at the
        top level of the drive. <span className="path">*</span> is any characters in a name, <span className="path">**</span> any number of folders.
      </p>
      {exclusions.length === 0 ? (
        <p>No Exclusions. Everything on the Primary is compared, apart from macOS's own system files.</p>
      ) : (
        <ul>
          {exclusions.map((pattern) => (
            <li key={pattern}>
              <span className="path">{pattern}</span>
              <button onClick={() => send({ type: "removeExclusion", pattern })} disabled={busy} aria-label={`Remove ${pattern}`}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          send({ type: "addExclusion", typed });
        }}
      >
        <label>
          Exclude:{" "}
          <input type="text" autoComplete="off" spellCheck={false} value={typed} disabled={busy} onChange={(event) => setTyped(event.target.value)} />
        </label>{" "}
        <button type="submit" disabled={busy || typed.trim() === ""}>Add</button>
      </form>
      <Problem text={state.exclusionProblem} />
    </section>
  );
}

function RefusedScreen({ state, send, busy }: ScreenProps<RefusedState>) {
  const { safetyStop, freeSpace } = state;
  const overridable = canOverrideSafetyStop(state);
  return (
    <>
      <h1>The Update is refused</h1>
      <OnlyFolderNote only={state.review.only} />
      {safetyStop !== undefined && <p className="problem">{safetyStopExplanation(safetyStop)}</p>}
      {freeSpace !== undefined && <p className="problem">{freeSpaceExplanation(freeSpace)}</p>}
      <p>Nothing was written to the Replica.</p>
      {overridable && <SafetyStopOverride stop={state.safetyStop} send={send} busy={busy} />}
      <Buttons>
        <button className={overridable ? undefined : "primary"} onClick={() => send({ type: "restart" })} disabled={busy}>Back to Start</button>
      </Buttons>
    </>
  );
}

/**
 * The only way past the Safety stop: typing the number of deletions. It holds for this comparison
 * only, and the usual Approvals still follow. What is typed stays on this screen until sent, and the
 * flow checks it.
 */
function SafetyStopOverride({ stop, send, busy }: { stop: SafetyStopRefusal; send(action: Action): void; busy: boolean }) {
  const [typed, setTyped] = useState("");
  return (
    <form
      className="override"
      onSubmit={(event) => {
        event.preventDefault();
        send({ type: "overrideSafetyStop", typed });
      }}
    >
      <h2>If you really did delete or move these files</h2>
      <p>
        Type the number of files no longer on the Primary to go ahead with this one comparison. You will still review and
        approve the copies and the deletions as usual. A new comparison starts without this override.
      </p>
      <label>
        Number of deletions:{" "}
        <input type="text" inputMode="numeric" autoComplete="off" value={typed} disabled={busy} onChange={(event) => setTyped(event.target.value)} />
      </label>{" "}
      <button type="submit" disabled={busy || typed.trim() === ""}>Override the Safety stop</button>
      <Problem text={stop.error} />
    </form>
  );
}

function CopiesScreen({ state, send, busy }: ScreenProps<CopiesState>) {
  const { review } = state;
  const copies = totalsOf(review.new, review.changed);
  return (
    <>
      <Steps current="copies" review={review} />
      <h1>Copies</h1>
      <OnlyFolderNote only={state.review.only} />
      {review.exclusions.length > 0 && (
        <p className="note">Left out by the Exclusions: {review.exclusions.join(", ")}.</p>
      )}
      <UnreadableList unreadable={review.unreadable} />
      <SectionList title="New" section={review.new} />
      <SectionList title="Changed" section={review.changed} />
      {review.anomalies.replicaNewer.count > 0 && (
        <section>
          <h2 className="warning">Anomaly, newer on the Replica: {describe(review.anomalies.replicaNewer)}</h2>
          <p className="warning">
            These changed files are newer on the Replica than on the Primary, which an Update never does: something else changed them there.
            Approving the copies replaces each with the Primary's version, as the Primary always wins. To keep a Replica version, copy it to
            the Primary first, then compare again.
          </p>
          <FileList files={review.anomalies.replicaNewer.files} />
        </section>
      )}
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

/**
 * The content mismatches a Deep verify found, each with its own choice: keep the Replica's copy, or
 * overwrite it with the Primary's. A file with no choice is left as it is.
 */
function AnomaliesScreen({ state, send, busy }: ScreenProps<AnomaliesState>) {
  const { review } = state;
  const mismatches = review.anomalies.contentMismatch;
  return (
    <>
      <Steps current="anomalies" review={review} />
      <h1>Anomalies</h1>
      <OnlyFolderNote only={state.review.only} />
      <p>
        These files have the same size and date on both drives, but Deep verify found their contents differ. That should not happen when only
        Updates change the Replica: its copy may be damaged, or was changed by something else. Choose for each file whether to keep the
        Replica's copy or overwrite it with the Primary's. An overwritten copy is moved into the Holding area, not destroyed. A file with no
        choice is left as it is.
      </p>
      <section>
        <h2 className="warning">Content mismatches: {describe(mismatches)}</h2>
        <ul className="files mismatches">
          {mismatches.files.map((file) => (
            <MismatchRow key={file.path} file={file} choice={review.mismatchChoices[file.path]} send={send} busy={busy} />
          ))}
        </ul>
      </section>
      <Buttons>
        <button onClick={() => send({ type: "restart" })} disabled={busy}>Start over</button>
        <button onClick={() => send({ type: "back" })} disabled={busy}>Back</button>
        <button className="primary" onClick={() => send({ type: "next" })} disabled={busy}>Next</button>
      </Buttons>
    </>
  );
}

/** One content mismatch, with its keep-or-overwrite choice. */
function MismatchRow({ file, choice, send, busy }: { file: ContentMismatch; choice: MismatchChoice | undefined; send(action: Action): void; busy: boolean }) {
  const option = (value: MismatchChoice, label: string) => (
    <label>
      <input
        type="radio"
        name={`mismatch:${file.path}`}
        checked={choice === value}
        disabled={busy}
        onChange={() => send({ type: "chooseForMismatch", path: file.path, choice: value })}
      />
      {label}
    </label>
  );
  return (
    <li>
      <span className="name">{file.path}</span>
      <span className="size">{formatSize(file.size)}</span>
      {file.replicaReadFailure !== undefined && <span className="reason">The Replica's copy could not be read: {file.replicaReadFailure}</span>}
      <span className="choice">
        {option("keep", "Keep the Replica's copy")} {option("overwrite", "Overwrite with the Primary's")}
      </span>
    </li>
  );
}

function MovesScreen({ state, send, busy }: ScreenProps<MovesState>) {
  const { review } = state;
  return (
    <>
      <Steps current="moves" review={review} />
      <h1>Moves</h1>
      <OnlyFolderNote only={state.review.only} />
      <p>
        These files were moved or renamed on the Primary. Each was matched by name, size and date, and its contents confirmed
        identical by checksum. Approving renames them on the Replica: nothing is copied, and nothing goes into the Holding area.
      </p>
      <MovesByFolder title="Moved" moves={review.moves} />
      <label className="confirm">
        <input type="checkbox" checked={review.movesApproved} disabled={busy} onChange={(event) => send({ type: "approveMoves", approved: event.target.checked })} />
        Rename all {describe(review.moves)} on the Replica.
      </label>
      <p className="note">Without this Approval, they stay at their old paths on the Replica, and nothing is copied to the new ones.</p>
      <Buttons>
        <button onClick={() => send({ type: "restart" })} disabled={busy}>Start over</button>
        <button onClick={() => send({ type: "back" })} disabled={busy}>Back</button>
        <button className="primary" onClick={() => send({ type: "next" })} disabled={busy}>Next</button>
      </Buttons>
    </>
  );
}

/** The Report's moves, grouped by the folder moved. Every folder expands to its full list of moves. */
function MovesByFolder({ title, moves }: { title: string; moves: MovesSection }) {
  return (
    <section>
      <h2>{title}: {moves.count === 0 ? "none" : describe(moves)}</h2>
      {moves.folders.map((group) => (
        <Expandable key={`${group.from}\0${group.to}`} label={`${folderLabel(group.from)} → ${folderLabel(group.to)}`} totals={group}>
          <MoveList moves={group.moves} />
        </Expandable>
      ))}
    </section>
  );
}

function folderLabel(folder: string): string {
  return folder === "" ? "(top level)" : `${folder}/`;
}

/** Each move, old path → new path. */
function MoveList({ moves }: { moves: (Move | FailedMove)[] }) {
  return (
    <ul className="files">
      {moves.map((move) => (
        <li key={move.from}>
          <span className="name">{move.from} → {move.to}</span>
          <span className="size">{formatSize(move.size)}</span>
          {"reason" in move && <span className="reason">{move.reason}</span>}
        </li>
      ))}
    </ul>
  );
}

function DeletionsScreen({ state, send, busy }: ScreenProps<DeletionsState>) {
  const { review } = state;
  const held = review.holdingArea;
  const them = held.count === 1 ? "it" : "them";
  return (
    <>
      <Steps current="deletions" review={review} />
      <h1>Deletions</h1>
      <OnlyFolderNote only={state.review.only} />
      {state.review.only !== undefined && <p className="warning">{onlyFolderDeletionsWarning(state.review.only)}</p>}
      <p>These files are on the Replica but no longer on the Primary. Approving moves them into the Holding area on the Replica, keeping their folders.</p>
      <SectionList title="Deleted" section={review.deleted} />
      {/* Right before the deletions Approval, as in ADR 0006. */}
      {held.count > 0 && (
        <p className="warning">
          The Holding area on the Replica holds {describe(held)} from an earlier Update. Approving these deletions deletes{" "}
          {them} permanently. To keep any of {them}, copy {them} back to the Primary first.
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
        <Expandable key={group.folder} label={folderLabel(group.folder)} totals={group}>
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
  const { copy, overwrite, keep, leaveUndecided, renameOnReplica, leaveAtOldPaths, moveToHoldingArea, deleteFromHoldingArea, leaveOnReplica } = state.apply;
  const canApply = writesAnything(state.apply);
  const { anomalies, mismatchChoices } = state.review;
  const hasCopies = totalsOf(state.review.new, state.review.changed).count > 0;
  return (
    <>
      <Steps current="summary" review={state.review} />
      <h1>Summary</h1>
      <OnlyFolderNote only={state.review.only} />
      <p>Apply will:</p>
      <ul className="summary">
        {copy.count > 0
          ? <li>Copy {describe(copy)} from the Primary to the Replica.</li>
          : hasCopies && <li>Copy nothing: the copies are not approved.</li>}
        {overwrite.count > 0 && <li className="warning">Overwrite {describe(overwrite)} with a content mismatch on the Replica with the Primary's copy, as you chose. The Replica's copies are moved into the Holding area.</li>}
        {keep.count > 0 && <li>Keep the Replica's copy of {describe(keep)} with a content mismatch, as you chose.</li>}
        {leaveUndecided.count > 0 && <li>Leave {describe(leaveUndecided)} with a content mismatch as they are on the Replica: no choice was made for them.</li>}
        {renameOnReplica.count > 0 && <li>Rename {describe(renameOnReplica)} moved on the Primary to their new paths on the Replica.</li>}
        {leaveAtOldPaths.count > 0 && <li>Leave the moved files at their old paths on the Replica: {describe(leaveAtOldPaths)}. The moves are not approved.</li>}
        {deleteFromHoldingArea.count > 0 && (
          <li className="warning">Permanently delete the {describe(deleteFromHoldingArea)} in the Holding area from an earlier Update.</li>
        )}
        {moveToHoldingArea.count > 0 && <li>Move {describe(moveToHoldingArea)} no longer on the Primary into the Holding area.</li>}
        {leaveOnReplica.count > 0 && <li>Leave the files only on the Replica where they are: {describe(leaveOnReplica)}. The deletions are not approved.</li>}
        {state.review.unreadable.length > 0 && (
          <li className="warning">
            Skip {itemCount(state.review.unreadable.length)} that could not be read on the Primary, leaving what the Replica holds there as it is.
          </li>
        )}
        <li>Write nothing to the Primary.</li>
      </ul>
      {anomalies.contentMismatch.count > 0 && (
        <Expandable label="Your choice for each content mismatch" totals={anomalies.contentMismatch}>
          <ul className="files">
            {anomalies.contentMismatch.files.map((file) => (
              <li key={file.path}>
                <span className="name">{file.path}</span>
                <span className="size">{formatSize(file.size)}</span>
                <span className="choice">{CHOICE_LABELS[mismatchChoices[file.path] ?? "none"]}</span>
              </li>
            ))}
          </ul>
        </Expandable>
      )}
      {state.review.safetyStopOverridden && (
        <p className="warning">The Safety stop is overridden for this Update, as you typed on the refusal screen.</p>
      )}
      {canApply ? <p className="note">Once Apply starts there is no going back.</p> : <p>Nothing is approved, so there is nothing to apply.</p>}
      <Buttons>
        <button onClick={() => send({ type: "restart" })} disabled={busy}>Start over</button>
        <button onClick={() => send({ type: "back" })} disabled={busy}>Back</button>
        <button className="primary" onClick={() => send({ type: "apply" })} disabled={busy || !canApply}>Apply</button>
      </Buttons>
    </>
  );
}

/** What the Summary says each content mismatch's choice does. */
const CHOICE_LABELS: Record<MismatchChoice | "none", string> = {
  keep: "Keep the Replica's copy",
  overwrite: "Overwrite with the Primary's",
  none: "No choice: left as it is",
};

function UpdatingScreen({ state }: { state: UpdatingState }) {
  const { moving, renaming, copying, overwriting } = state;
  // In the order Apply does them: deletions, then moves, then copies (see update()).
  const work = [
    ...(moving.count > 0 ? [`moving ${describe(moving)} into the Holding area`] : []),
    ...(renaming.count > 0 ? [`renaming ${describe(renaming)} moved on the Primary`] : []),
    ...(copying.count > 0 ? [`copying ${describe(copying)} to the Replica`] : []),
    ...(overwriting.count > 0 ? [`overwriting ${describe(overwriting)} on the Replica with the Primary's`] : []),
  ].join(", then ");
  const bar = updatingBar(state.progress);
  return (
    <>
      <Waiting title="Updating…" detail={`${work.charAt(0).toUpperCase()}${work.slice(1)}. Keep both drives connected.`} />
      {updatingLines(state.progress).map((line) => <p key={line.slice(0, line.indexOf(":"))} className="note progress-line">{line}</p>)}
      {bar !== undefined && <Bar bar={bar} />}
      <p className="note" role="status">{PRIMARY_MOUNT[state.primary]}</p>
    </>
  );
}

/** What the Updating screen says about the Primary, so the owner knows why it disappears and comes back. */
const PRIMARY_MOUNT: Record<UpdatingState["primary"], string> = {
  "remounting read-only":
    "Remounting the Primary read-only, so that macOS itself keeps it from being written to. It may briefly disappear from the Finder.",
  "read-only": "The Primary is mounted read-only for this Update: macOS itself keeps it from being written to.",
  "remounting normally": "Remounting the Primary normally. It may briefly disappear from the Finder.",
};

function ResultScreen({ state, send, busy }: ScreenProps<ResultState>) {
  const copied = totalsOfFiles(state.copied);
  const moved = totalsOfFiles(state.moved);
  const renamed = totalsOfMoves(state.renamed);
  const problems = state.error !== undefined || state.primaryStillReadOnly !== undefined || state.failed.length > 0 || state.notRenamed.length > 0 || state.notMoved.length > 0 || state.unreadable.length > 0 || state.notRecorded !== undefined;
  return (
    <>
      <h1>{problems ? "Update finished with problems" : "Update done"}</h1>
      <OnlyFolderNote only={state.only} />
      <Problem text={state.error === undefined ? undefined : `The Update stopped: ${state.error}`} />
      <Problem text={state.primaryStillReadOnly === undefined ? undefined : `The Primary may still be read-only: ${state.primaryStillReadOnly}`} />
      <Problem text={state.notRecorded === undefined ? undefined : notRecordedWarning(state.notRecorded)} />
      <UnreadableList unreadable={state.unreadable} />
      <section>
        <h2>Copied: {copied.count === 0 ? "none" : describe(copied)}</h2>
        {copied.count > 0 && (
          <Expandable label="Every copied file" totals={copied}>
            <FileList files={state.copied} />
          </Expandable>
        )}
      </section>
      {state.overwritten.length > 0 && (
        <section>
          <h2>Content mismatches overwritten with the Primary's copy: {describe(totalsOfFiles(state.overwritten))}</h2>
          <p>The Replica's previous copies are in the Holding area.</p>
          <FileList files={state.overwritten} />
        </section>
      )}
      {state.failed.length > 0 && (
        <section>
          <h2 className="problem">Not copied: {fileCount(state.failed.length)}</h2>
          <p>The Replica keeps its earlier version of each, if any.</p>
          <FileList files={state.failed} />
        </section>
      )}
      {renamed.count > 0 && (
        <section>
          <h2>Renamed to their new paths: {describe(renamed)}</h2>
          <Expandable label="Every renamed file" totals={renamed}>
            <MoveList moves={state.renamed} />
          </Expandable>
        </section>
      )}
      {state.notRenamed.length > 0 && (
        <section>
          <h2 className="problem">Not renamed: {fileCount(state.notRenamed.length)}</h2>
          <p>Each is still at its old path on the Replica. Compare again to see it.</p>
          <MoveList moves={state.notRenamed} />
        </section>
      )}
      {state.movesLeftAtOldPaths.count > 0 && <p className="note">Left at their old paths on the Replica: {describe(state.movesLeftAtOldPaths)} moved on the Primary.</p>}
      {moved.count > 0 && (
        <section>
          <h2>Moved into the Holding area: {describe(moved)}</h2>
          <Expandable label="Every moved file" totals={moved}>
            <FileList files={state.moved} />
          </Expandable>
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
      <section className="holding-area">
        <h2>The Holding area</h2>
        {state.holdingArea !== undefined && holdingAreaReminder(state.holdingArea).map((line) => <p key={line}>{line}</p>)}
        <Problem text={state.holdingAreaProblem === undefined ? undefined : `The Holding area could not be read: ${state.holdingAreaProblem}`} />
      </section>
      {state.updateLog !== undefined && <p className="note">This Update is logged on this Mac in {state.updateLog}</p>}
      <Problem text={state.updateLogProblem === undefined ? undefined : `This Update could not be logged on this Mac: ${state.updateLogProblem}`} />
      <Buttons>
        <button className="primary" onClick={() => send({ type: "restart" })} disabled={busy}>Done</button>
      </Buttons>
    </>
  );
}

/**
 * Unreadable: what could not be read on the Primary, so it was skipped. Shown in full, since each
 * one is something the Replica may not have an up-to-date backup of.
 */
function UnreadableList({ unreadable }: { unreadable: Unreadable[] }) {
  if (unreadable.length === 0) return null;
  return (
    <section>
      <h2 className="problem">Could not be read on the Primary: {itemCount(unreadable.length)}</h2>
      <p>
        These were skipped. Whatever the Replica holds at these paths stays where it is, and is never moved into the
        Holding area. Check the Primary (permissions, or a failing drive), then compare again.
      </p>
      <ul className="files">
        {unreadable.map((item) => (
          <li key={item.path}>
            <span className="name">{item.folder ? `${item.path}/ (folder)` : item.path}</span>
            <span className="reason">{item.reason}</span>
          </li>
        ))}
      </ul>
    </section>
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

/** A progress bar with what it says beneath. Without a fraction, a moving bar with no percentage. */
function Bar({ bar }: { bar: ProgressBar }) {
  // Rounded down, so a bar short of full never reads 100%.
  const percent = bar.fraction === undefined ? undefined : Math.floor(bar.fraction * 100);
  return (
    <div className="bar">
      {percent === undefined ? <progress aria-label={bar.label} /> : <progress aria-label={bar.label} max={100} value={percent} />}
      <p className="note">
        {bar.label}
        {percent === undefined ? "" : ` · ${percent}%`}
      </p>
    </div>
  );
}

const STEP_LABELS: Record<ReviewStep, string> = { copies: "Copies", anomalies: "Anomalies", moves: "Moves", deletions: "Deletions", summary: "Summary" };

/**
 * Where the review is, among the steps up to Apply. Anomalies is there only when there are content
 * mismatches, Moves and Deletions only when there is something to move or delete.
 */
function Steps({ current, review }: { current: ReviewStep; review: Review }) {
  return (
    <ol className="steps">
      {reviewSteps(review).map((step) => <li key={step} aria-current={current === step ? "step" : undefined}>{STEP_LABELS[step]}</li>)}
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

