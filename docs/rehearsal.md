# Rehearsal: practise on fake drives

Before the first run on the real drives, rehearse the whole workflow on two fake ones. They are disk images that macOS mounts in `/Volumes` like external drives, each with its own Volume ID. The fake **Primary** starts as a copy of a folder you choose. The fake **Replica** starts empty.

The rehearsal keeps everything apart from the real thing. The disk images, and the Pairing, Exclusions and Update logs of the app you open for the rehearsal, all live in one rehearsal folder, `~/Library/Application Support/sync-drive-rehearsal/`. The real Pairing and Update logs in `~/Library/Application Support/sync-drive/` are never read or changed. Removing the rehearsal deletes that folder and nothing else.

Allow about half an hour. Commands are typed in Terminal, in the sync-drive folder.

## 1. Make the fake drives

1. Quit sync-drive if it is open.
2. Eject every other external drive and disk image, such as an app's installer: Pairing needs exactly two drives connected (ADR 0020). The Finder's sidebar, under Locations, shows what is connected.
3. Choose a folder to copy onto the fake Primary. Pick one with a few subfolders and some hundreds of files, a few hundred MB in all: photos, say. It is only read, never changed. Its copy takes that much space on the Mac, and as much again once the first Update copies it to the fake Replica.
4. Make the drives, giving that folder:

   ```sh
   npm run rehearsal:create ~/Pictures/Some\ Folder
   ```

   It prints both drives, `Rehearsal Primary` and `Rehearsal Replica`, with their Volume IDs, and names any other drive still connected. Both drives now show in the Finder's sidebar. `Rehearsal Primary` holds what the folder holds.

## 2. Pair them

1. Open the app for the rehearsal. This builds it first, then opens it with the rehearsal's own Pairing:

   ```sh
   npm run rehearsal:app
   ```

   (Not `npm start`: that one keeps its Pairing with the real ones, and the rehearsal would replace it.)
2. **Pair the drives** lists the two drives, each with its size and Volume ID. Compare the Volume IDs with what `rehearsal:create` printed. If it says more drives are connected, eject the ones it names, then click **Look again**.
3. Pick `"Rehearsal Primary"` as the Primary. **The Pairing to save** names the Primary and the Replica with their Volume IDs. Click **Save Pairing**.

**Start** shows both drives and says *sync-drive has not updated the whole Replica yet.*

## 3. The first Update: copy everything

1. Click **Compare**. A progress bar shows the comparison. Nothing is written to either drive.
2. **Copies** lists every file under **New**, grouped by folder. Click a folder to see its files. Tick **Copy all … to the Replica.**, then **Next**. Moves and Deletions are skipped: there is nothing in them yet.
3. **Summary** says Apply will copy those files, and *Write nothing to the Primary.* Click **Back**: Copies still has its tick. Click **Next** again.
4. Before you click **Apply**, open a second Terminal window and keep it running through the Update. It prints whether the Primary is read-only every half second (it prints nothing while the Primary is unmounted):

   ```sh
   while true; do diskutil info "/Volumes/Rehearsal Primary" 2>/dev/null | grep "Volume Read-Only"; sleep 0.5; done
   ```

5. Click **Apply**. The Updating screen says the Primary is being remounted read-only, and it may briefly disappear from the Finder. The Terminal shows `Volume Read-Only: Yes` while the files are copied, then `No` again once it is done. (With a small folder the Update can be over in a few seconds. Watch the Terminal, not the screen.) Press Control-C in that Terminal window to stop it.
6. **Update done** lists what was copied, says the Holding area on the Replica is empty, and names the Update log. It is in the rehearsal folder, not among the real logs. Click **Done**.

Start now says *Replica last updated today, on …*, a moment after it appears. It reads that from a hidden `.sync-drive-last-updated` file the Update left at the top level of `Rehearsal Replica`; each Replica has its own. Had the Update left undone something you approved, such as a file it could not copy, Start would say *Replica last partly updated …* and how many items were left undone, and the Update log would list them with the reasons.

The Primary is writable again. macOS writes its own `.fseventsd` log to it whenever it is mounted normally, as on any connect. sync-drive does not write it, and every comparison skips it.

## 4. An app using the Primary blocks the Update

1. In Terminal, go into the Primary: `cd "/Volumes/Rehearsal Primary"`.
2. In the Finder, change a file on `Rehearsal Primary`: open a text file, add a line, save. Or duplicate a photo.
3. In the app, **Compare**, approve the copies, **Next**, then **Apply**.
4. The Update is refused and nothing is written: the Primary is in use, and macOS often names the process using it (here, your Terminal's shell). The app goes back to Start. The Primary was never forced off, so no app could lose unsaved work.
5. In Terminal, leave the drive: `cd ~`. Then **Compare** and **Apply** again. This time it goes ahead.

## 5. Delete, move and change files, and update again

On `Rehearsal Primary`, in the Finder:

- Delete two or three files, and empty the Trash. (Files in the Trash are still on the drive, in its hidden `.Trashes` folder, which sync-drive skips.)
- Move one folder into another folder.
- Change one file, as in section 4.

Then in the app:

1. **Compare**. The review steps are now **Copies**, **Moves** and **Deletions**, then **Summary** and **Apply**.
2. **Copies** lists the changed file. Tick its Approval, **Next**.
3. **Moves** lists each moved file, old path → new path, grouped by folder. Approving renames them on the Replica: nothing is copied. Tick it, **Next**.
4. **Deletions** lists the deleted files. Approving moves them into the Holding area. Tick it.
5. Click **Back** twice, to Copies, then **Next** twice: every tick is still there. (**Start over** would discard them.)
6. **Next** to the **Summary**. It says what Apply will copy, rename and move into the Holding area, and *Write nothing to the Primary.* Start the Terminal check from section 3 again if you want to see the Primary go read-only for this Update too, then click **Apply**.
7. The Result lists what was copied, renamed, and moved into the Holding area. **The Holding area** section says how many files it now holds, when it was last added to, and how to restore one. Click **Done**.

On `Rehearsal Replica`, in the Finder, open the `sync-drive Holding Area` folder: the deleted files are there in their original folders, with a `READ ME.txt` that says how to restore them. The moved folder is at its new place, not copied again.

## 6. Restore a file from the Holding area

1. Copy one deleted file from `sync-drive Holding Area` on the Replica back to `Rehearsal Primary`, into its original folder. Dragging it from one drive to the other copies it. Do not move it back within the Replica: the next Update would treat it as deleted again.
2. **Compare**. **Copies** lists the restored file as new. Approve it and apply.

The copy in the Holding area stays there until the next Update whose deletions you approve.

## 7. The Holding area warning

1. Delete another file on `Rehearsal Primary` and empty the Trash.
2. **Compare**, then **Next** to **Deletions**. Above its Approval, it warns that the Holding area holds files from an earlier Update, and that approving these deletions deletes them permanently. To keep any of them, you would copy them back to the Primary first, as in section 6.
3. Tick the Approval, **Next**. The Summary lists *Permanently delete the … in the Holding area from an earlier Update.* Click **Apply**.

The Holding area now holds only the file you just deleted.

## 8. An Update limited to one folder

1. On `Rehearsal Primary`, choose a folder with a few files in it. Move one of its files out of it, to the top level of the drive. Delete another of its files.
2. On Start, click **Limit to one folder…** and choose that folder. Start says *Only the folder "…"*.
3. **Compare**. Each review step, and the Summary and Result, say the run is limited to that folder, and that files moved into or out of it show as new or deleted rather than as moves.
4. **Deletions** lists both files, the one you moved out and the one you deleted, and warns about files moved out of the folder: the copy there may be their only backup. The file at the top level is not listed anywhere: it is outside the folder. It also gives the Holding area warning from section 7: the Holding area still holds the file you deleted there, and approving these deletions deletes it for good.
5. Approve and apply. The Summary lists the permanent deletion from the Holding area too. On Start, *Since then, only the folder "…" was updated* now follows *Replica last updated*.
6. Click **Compare the whole drive**, then **Compare**: the file you moved to the top level now shows as new. Apply it, so that the whole Replica is up to date again.

## 9. If the app is force-quit during an Update

You do not need to try this. If the app crashes or is force-quit during an Update, the Primary stays read-only, which is safe: nothing can write to it. It stays read-only until it is ejected and connected again. For the rehearsal Primary, connecting it again means opening its disk image: eject `Rehearsal Primary` in the Finder, then run

```sh
open ~/Library/Application\ Support/sync-drive-rehearsal/Primary.sparseimage
```

On a real drive, unplug it and plug it back in.

## 10. Remove the fake drives

1. Quit the app, and close any Finder or Terminal window on the fake drives.
2. Eject the drives and delete everything the rehearsal made:

   ```sh
   npm run rehearsal:remove
   ```

   It names the drives it ejected and their Volume IDs, and deletes the rehearsal folder with its Pairing, Exclusions and Update logs. The folder you copied from is untouched.

For the real drives, use `npm start`. It opens on Pairing the first time, as the rehearsal did.
