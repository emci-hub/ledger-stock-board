/**
 * Practice Run account page — /account/:id
 *
 * Same four sections as the home detail block (scorecard → picks → trades →
 * analysis), for this account only. Unknown ids get a "not in snapshot"
 * message rather than being dropped.
 */
(function () {
  "use strict";

  const P = window.PracticeRun;
  const el = (id) => document.getElementById(id);

  function accountIdFromPath() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    if (parts[0] !== "account" || !parts[1]) return "";
    try {
      return decodeURIComponent(parts[1]);
    } catch {
      return parts[1];
    }
  }

  function showState(message, isError) {
    const node = el("state-msg");
    node.hidden = false;
    node.textContent = message;
    node.className = isError ? "state-msg err" : "state-msg";
    el("page").hidden = true;
  }

  async function load() {
    const id = accountIdFromPath();
    if (!id) {
      showState("No account id in the URL. Go back to all accounts.", true);
      return;
    }

    let result;
    try {
      result = await P.loadSnapshot();
    } catch (err) {
      showState(
        err && /HTTP/.test(err.message)
          ? `The practice run could not be loaded (${err.message}).`
          : "Could not reach the server to load this account.",
        true
      );
      return;
    }

    if (result.empty) {
      showState("No practice-run snapshot has been synced yet.", false);
      return;
    }

    const account = result.accounts.find((row) => String(row.id) === id);
    if (!account) {
      const known = result.accounts.map((row) => row.id).filter(Boolean);
      showState(
        `Account “${id}” is not in the latest snapshot.${
          known.length ? ` Synced ids: ${known.join(", ")}.` : ""
        }`,
        true
      );
      return;
    }

    document.title = `${P.displayName(account)} — Practice Run — Ledger`;
    el("page").innerHTML = `
      ${P.accountDetailHtml(account, result.snapshot, { compact: false, idPrefix: "page" })}
      <p class="disclaimer" role="note">
        <strong>Pretend money, not financial advice.</strong>
        <span>Updated ${P.escapeHtml(P.formatMt(result.snapshot.updatedAt))} MT. Every number is from the synced snapshot.</span>
      </p>
    `;
    el("state-msg").hidden = true;
    el("page").hidden = false;
  }

  load();
})();
