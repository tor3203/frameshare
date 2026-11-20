# FrameShare

A first working version of a shared video and image review studio. Uses a Cloudflare Worker, D1 for live collaboration, and R2 for files and durable notes. No runtime packages or external sign-in providers.

## Run locally

Install Node.js 22.13 or later. From the repository root, run:

```sh
npm ci
npm run dev
```

Open http://localhost:4173. The dev server applies SQLite migrations on startup and stores local room data in `.local/objects` and `.local/collaboration.sqlite`.

Run `npm test` for the automated test suite and `npm run build` to generate the Worker bundle at `dist/server/index.js`. Local development and bundle generation work without deployment credentials. A live Cloudflare deployment needs its own D1 database and R2 bucket bound as `DB` and `BUCKET`, plus the SQL migrations in `drizzle/`.

## Review workflow

Create a room with a review title and your display name, upload videos or images (up to 80 MB per item), and copy the private invite link. A coworker opens the link, enters a display name, and joins without an account, email, or password.

- **Shot browser:** thumbnail cards open the latest revision; expandable version stacks open older revisions or launch side-by-side comparison. Search covers shot names, filenames and version labels. Status filtering uses each shot’s latest revision. Shared up/down controls reorder whole shots; filters, expanded stacks and collapsed browser state are local.
- **Review status:** each version has Needs review, Changes requested or Approved status, with the last reviewer name and time. New revisions start at Needs review; older decisions survive rename/group changes. All joined guests can update status.
- **Shots and revisions:** uploads start as separate shots. Use **Group / rename** to group existing media and name each version; **Add revision** uploads into the active shot. Group names and version labels are shared with all guests.
- **Comparison:** choose A from the shot’s version selector, B from Reference, then Side-by-side or Wipe. Play, pause, seek, frame step and speed changes keep both players on the same elapsed time; B is muted. A shorter reference holds its last frame. The presenter shares the comparison pair, mode and wipe position with followers. With no presenter, views are local. **Review B’s notes** swaps A/B at the current time.
- **Version feedback:** comments, drawings, drafts, undo and exports remain attached to immutable media IDs. The conversation panel clearly names A; B shows only its own drawings. Grouping never copies annotations.
- **HUD:** toggle the local HUD to see the shared presenter, whether you are following or controlling local/shared playback, connection state, frame/time and view mode. The preference survives reloads; reconnecting status labels the presenter as last known.
- **Playback:** enable **Lead review** on the presenting client. Other clients follow automatically. Manual navigation on a follower turns off **Follow presenter** for local exploration; re-enable it to catch up. If someone is already presenting, checking Lead review requests control; the presenter can Pass control or Decline. Unchecking releases control. Requests show their remaining 30-second lifetime and provide explicit expired/declined feedback and a retry action. Handoff buttons remain stable during live updates. A disconnected presenter loses their lease after 15 seconds, pausing at the last known position projected to lease expiry. Reloaded tabs return as followers.
- **Frames:** choose the source frame rate for stepping (24/25/30/60 fps), jump to a frame number, adjust playback speed, and use timeline annotation markers. Space toggles playback; Left/Right step frames, Shift+Left/Right jump a second, Up/Down navigate annotations.
- **Cursors and identity:** guests receive a stable session color, shown in participant chips, named live cursors and laser pointers. Cursors track the media under the pointer, including comparison references. They hide outside the media or after an 8-second presence timeout; saved notes never contain cursor movement. Drawings start in your identity color but can use a chosen ink color.
- **Drawings:** pen, arrow, and rectangle tools, color and width selection, per-frame undo/redo for your own sketches, and annotated PNG export. Live previews show strokes before completion. Hold and move the Laser tool (L) to point temporarily; it fades after 1.5 seconds and is excluded from notes and exports. P selects pen, V selects navigation, Ctrl/Cmd+Z undoes a drawing.
- **Notes:** frame-anchored drafts, threaded replies, author-only edits, resolution status, search and Open/Resolved filters, and JSON export. Drafts, pending annotation saves, and recent room links are stored on the current browser/device. Pending saves retry after reconnect/reload with stable request IDs to prevent duplicates.

Playback starts muted so browser autoplay restrictions do not block a follower; uncheck **Muted** to hear audio. Browser support determines which uploaded codecs play. MP4/H.264 and WebM are recommended; accepted MOV files may require conversion outside the app. No automatic transcoding is performed.

## Architecture and limits

Rooms, immutable review events, and original uploads are persisted in R2 (`BUCKET`). D1 (`DB`) stores presenter authority and expiring gestures. Version-checked SQL updates arbitrate competing claims; presenter terms and ordered sequences reject stale playback. Each page gets a separate connection identity even when tabs share a guest cookie. `/stream` uses same-origin SSE with bounded stream rotation and automatic reconnect; snapshots refresh about every 200 ms plus database/network latency. A separate `/live` request refreshes media, presence and clock offset, and becomes a faster fallback if SSE fails. Durable notes remain paginated; stream revision hints trigger refreshes. This is near-real-time synchronization, not frame-locked playback or WebSockets.

Worker entrypoint: `worker/index.js`; implementation: `worker/core.js`. The frontend is `web/studio.html`, `web/styles.css`, and `web/app.js`. `scripts/build.mjs` embeds the frontend into the server bundle without runtime dependencies. The local R2 adapter atomically replaces objects and serializes concurrent access on Windows. Known-length hosted uploads use Cloudflare FixedLengthStream; the fallback uses an ArrayBuffer. Media reads support HEAD, byte ranges, and explicit lengths for seeking.

## Smoke tests

With the dev server running in a separate terminal, run these commands from the repository root:

```sh
node scripts/smoke-live.mjs http://localhost:4173 scripts/fixtures/review-clock-30s.mp4
node scripts/smoke-collaboration.mjs http://localhost:4173
node scripts/smoke-cursors.mjs http://localhost:4173
node scripts/smoke-library.mjs http://localhost:4173
node scripts/smoke-versions.mjs http://localhost:4173
```

The fixtures in `scripts/fixtures/` are synthetic test media. The live smoke test accepts another MP4 path, or you can omit that argument to exercise just the image workflow. Each script creates a test room on the target server and writes a JSON report to the ignored `test-results/` directory.

## Private invite access

The hosting audience is public so visitors can reach the join screen without a ChatGPT account. Each room URL contains an unguessable random UUID that serves as its invite key. There is no room listing. Anyone who possesses the full room link can join; forwarding the link grants the same access. Display names are self-selected, not verified identities.

Joining creates a server-side guest session in R2, with a random 256-bit session token in a Secure, HttpOnly, SameSite=Lax cookie scoped to the room's API path. Room details, review events, upload metadata, and original media all require that room's unexpired session. Comments and presence use the server session's name and participant ID. Sessions expire after seven days, after which the visitor can rejoin from the invite link. Existing room links and stored review data remain compatible. Referrer and indexing headers reduce accidental link disclosure.

No external authentication or email provider is used. All joined guests have equal collaboration access, including uploading and selecting shared media. Link revocation, host/guest roles, moderation, quotas, deletion UI, audio calls, and transcoding are not implemented. This is an MVP for small team reviews. Latency depends on network/database conditions. Intermediate gestures and rapid play/pause states can be coalesced; the latest authoritative playback state is restored. It is not a substitute for production-scale SyncSketch yet.

Comparison aligns elapsed time, not editorial content: automatic shot alignment, manual time offsets and difference blending are not included. Comparisons use two videos or two still images of the same shot; browser codec support still applies.

Thumbnail previews are generated lazily in the browser from decodable media, saved as small JPEGs in the protected room, and shared with later visitors. Missing previews show a media icon; unsupported codecs remain subject to browser support. Original files and annotation IDs are never changed. UUID or unnamed uploads receive readable catalog display names while retaining their original filenames.

## License

FrameShare is available under the [MIT License](LICENSE).
