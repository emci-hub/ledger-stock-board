/**
 * One map from synced account ids to page sections, names, and blurbs.
 *
 * The sync payload is not changed. Pages only use this file to decide
 * where an id sits and what plain-English label it gets. Unknown ids are
 * still shown, in an "Other accounts" section, in the order they arrived.
 *
 * Loaded in the browser as window.AccountGroups and required by node tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AccountGroups = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const ACCOUNT_GROUPS = [
    {
      id: "watchlist",
      title: "Watchlist",
      summary:
        "Advice only, no money. A graded list of companies the lab is allowed to study. Nothing here is a trade.",
      href: "/watchlist",
      hrefLabel: "Open the watchlist",
      muted: false,
      collapsed: false,
      members: [
        {
          id: "lt-watch",
          name: "Watchlist",
          blurb:
            "Companies graded A to F. The lab may buy only from this list. Advice only, no pretend money.",
          href: "/watchlist",
        },
      ],
    },
    {
      id: "lab",
      title: "Strategy Lab",
      summary:
        "Five pretend US$1,000 accounts, each following one fixed strategy, picking only from the watchlist. We see which beats simply holding.",
      href: "/lab",
      hrefLabel: "Open Strategy Lab",
      muted: false,
      collapsed: false,
      members: [
        {
          id: "baseline",
          name: "Buy & hold A/B names, the bar to beat",
          blurb: "Bought the top-graded stocks once and holds them. The bar to beat.",
        },
        {
          id: "ghost-orig",
          name: "Ghost Dip, Gemini version",
          blurb:
            "Waits for a great company to drop hard, checks why with AI, buys once the chart turns up.",
        },
        {
          id: "us-ghost",
          aliases: ["ghost-fixed"],
          name: "Ghost Dip, red-teamed",
          blurb:
            "Same idea with stricter safety rules: smaller bets, set exits, a profit-taking rule.",
        },
        {
          id: "ghost-macro",
          name: "Ghost Dip + market weather",
          blurb:
            "Red-teamed Ghost Dip, but holds off buying while the sector is sliding, fear (VIX) is high, junk bonds are weak, or a CPI/Fed day is near.",
        },
        {
          id: "momentum",
          name: "Breakout momentum",
          blurb: "Buys strong stocks hitting new highs on big volume, sells when the trend breaks.",
        },
      ],
    },
    {
      id: "lab-backtest",
      title: "Strategy Lab, 3-month backtest",
      summary:
        "The same four strategies replayed from mid-July with US$1,000 each, buying only on days their rules fired, then continuing live from Oct 19. Shows what could have happened. The AI check is replaced by fixed rules in the replay.",
      href: "/lab#backtest",
      hrefLabel: "See the replay",
      muted: false,
      collapsed: false,
      members: [
        {
          id: "bt-ghost-orig",
          name: "Ghost Dip, Gemini (backtest)",
          blurb:
            "Waits for a great company to drop hard, checks why with AI, buys once the chart turns up. (replayed from Jul 16)",
          badge: "Backtest",
          started: "2026-07-16",
        },
        {
          id: "bt-ghost-fixed",
          name: "Ghost Dip, red-teamed (backtest)",
          blurb:
            "Same idea with stricter safety rules: smaller bets, set exits, a profit-taking rule. (replayed from Jul 16)",
          badge: "Backtest",
          started: "2026-07-16",
        },
        {
          id: "bt-ghost-macro",
          name: "Ghost Dip + market weather (backtest)",
          blurb:
            "Red-teamed Ghost Dip, but holds off buying while the sector is sliding, fear (VIX) is high, junk bonds are weak, or a CPI/Fed day is near. (replayed from Jul 16)",
          badge: "Backtest",
          started: "2026-07-16",
        },
        {
          id: "bt-momentum",
          name: "Breakout momentum (backtest)",
          blurb:
            "Buys strong stocks hitting new highs on big volume, sells when the trend breaks. (replayed from Jul 16)",
          badge: "Backtest",
          started: "2026-07-16",
        },
      ],
    },
    {
      id: "long-term",
      title: "Long-term",
      summary:
        "Frozen buy-and-hold rules. One account, left alone while we see how the marks compare with the market.",
      href: "",
      hrefLabel: "",
      muted: false,
      collapsed: false,
      members: [
        {
          id: "us-day",
          name: "US Long-Term v5",
          blurb: "Buy-and-hold quality companies in small steps, rules frozen while we test.",
          neverPaused: true,
        },
      ],
    },
    {
      id: "older",
      title: "Older experiments",
      summary:
        "Earlier paper tests. No new trades are being added. The last marks stay here so we can look back.",
      href: "",
      hrefLabel: "",
      muted: true,
      collapsed: true,
      members: [
        {
          id: "ca-swing",
          name: "Canadian swing",
          blurb: "Holds Canadian stocks for a few days, not minutes. An earlier test, still showing its last marks.",
        },
        {
          id: "glb-branch",
          name: "Green-line breakout",
          blurb: "Buys when a stock breaks a rising line of new highs. Measured against the broad US market.",
        },
        {
          id: "lottery-us",
          name: "US lottery (high-risk small bets)",
          blurb: "Small bets on risky US names. Most will lose. A few winners are meant to pay for the rest.",
        },
        {
          id: "lottery-ca",
          name: "Lottery (high-risk small bets)",
          blurb: "The same high-risk idea in Canadian dollars. Small bets, and most of them are expected to lose.",
        },
        {
          id: "ca-day",
          name: "Canadian day trading (paused)",
          blurb: "Intraday trades in Canadian stocks. Paused, so there are no new picks.",
        },
        {
          id: "us-swing",
          name: "US swing (shelved, tracking last positions)",
          blurb: "An earlier US swing book. Shelved. We only track the positions that are still open.",
          shelved: true,
        },
      ],
    },
  ];

  const BY_ID = new Map();
  ACCOUNT_GROUPS.forEach((group) => {
    group.members.forEach((member) => {
      const ids = [member.id].concat(member.aliases || []);
      ids.forEach((id) => {
        BY_ID.set(id, member);
      });
    });
  });

  function profileFor(id) {
    return BY_ID.get(String(id || "")) || null;
  }

  function displayName(account) {
    const profile = profileFor(account && account.id);
    if (profile) return profile.name;
    if (account && account.name) return String(account.name);
    if (account && account.id) return String(account.id);
    return "Account";
  }

  function blurbFor(id) {
    const profile = profileFor(id);
    return profile ? profile.blurb : "";
  }

  function preferredOrder() {
    const ids = [];
    ACCOUNT_GROUPS.forEach((group) => {
      group.members.forEach((member) => ids.push(member.id));
    });
    return ids;
  }

  /**
   * Sections in reading order. A section with no synced accounts is omitted.
   * Any id that is not in the map is appended, never dropped.
   */
  function groupAccounts(accounts) {
    const list = Array.isArray(accounts) ? accounts.filter(Boolean) : [];
    const byId = new Map();
    list.forEach((account) => {
      const id = String(account.id || "");
      if (!byId.has(id)) byId.set(id, account);
    });
    const seen = new Set();
    const sections = ACCOUNT_GROUPS.map((group) => {
      const matched = [];
      group.members.forEach((member) => {
        const ids = [member.id].concat(member.aliases || []);
        ids.forEach((id) => {
          const account = byId.get(id);
          if (!account || seen.has(account)) return;
          seen.add(account);
          matched.push(account);
        });
      });
      return {
        id: group.id,
        title: group.title,
        summary: group.summary,
        href: group.href || "",
        hrefLabel: group.hrefLabel || "",
        muted: Boolean(group.muted),
        collapsed: Boolean(group.collapsed),
        accounts: matched,
      };
    }).filter((group) => group.accounts.length);

    const other = list.filter((account) => !seen.has(account));
    if (other.length) {
      sections.push({
        id: "other",
        title: "Other accounts",
        summary: "These came in with the snapshot and are not in a named group. They are still shown.",
        href: "",
        hrefLabel: "",
        muted: false,
        collapsed: false,
        accounts: other,
      });
    }
    return sections;
  }

  function sortAccountsForDisplay(accounts) {
    return groupAccounts(accounts).reduce((all, group) => all.concat(group.accounts), []);
  }

  return {
    ACCOUNT_GROUPS,
    profileFor,
    displayName,
    blurbFor,
    preferredOrder,
    groupAccounts,
    sortAccountsForDisplay,
  };
});
