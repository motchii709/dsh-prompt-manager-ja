/**
 * Browser half of @lolkda/dsh-prompt-manager: the「プロンプト」settings section.
 *
 * The section has two views. The landing view lists the prompt entries: each row
 * is a title, an injection switch, and a kebab menu carrying that row's actions
 * (edit, delete). Choosing 編集 opens the editor view — the whole section area
 * becomes the markdown editor and its preview, with a return control — so the
 * panel's narrow column is spent on one thing at a time.
 *
 * The index (title, order, enabled) rides the shared settings transport through
 * `ctx.configForms.get(entryId)` — the entry id being this package's Loader row,
 * which is also the settings namespace on DSH 0.1.7; the bodies ride the plugin's
 * own `/dsh-prompt-manager` route, because they are markdown files on disk.
 *
 * Built in the client module system's lazy-CJS factory format by hand, so the
 * package needs no bundler: the factory only requests modules the shell's
 * platform table already carries (`react` and the UI primitives).
 *
 * Registered as `exports.name` / `exports.inject` / `exports.apply`, the same
 * shape every other client bundle exports. The factory id is the package name —
 * that is how the client module system ties this bundle to its Loader row.
 */
window.__ModuleLoader__.load({
  id: '@lolkda/dsh-prompt-manager',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement

    /** Settings namespace carrying the entry index. Mirrors the Host constant. */
    const NAMESPACE = 'prompt-manager'

    /** Prefix of the Host route serving the body files. */
    const ROUTE = '/dsh-prompt-manager'

    /** Placement the section claims in the settings navigation. */
    const SECTION_ORDER = 60

    /**
     * The composer slot the preset chip claims: the tool row's trailing group,
     * in front of the model selector, which is where a person looks when they
     * want to change what this conversation is working with.
     */
    const PRESET_SLOT = 'conversation.input.right'

    /**
     * The id the compaction chip claims in that row. The row is a list, so the two chips
     * share its slot name but not their id — a slot keyed by id would otherwise treat
     * the second registration as a replacement for the first.
     */
    const COMPACTION_CHIP_ID = `${NAMESPACE}-compaction`

    /**
     * The id meaning "none of them": no preset — each entry's own switch decides —
     * or no compaction instruction, which leaves DSH's own text in force. Mirrors
     * the Host, which reads an empty or unknown id the same way.
     */
    const NO_PRESET = ''

    /** Style tag identity, so unload removes exactly this bundle's styles. */
    const STYLE_ID = 'dsh-prompt-manager/Section.css'

    /**
     * This plugin's own repository, shown on the section's heading line.
     *
     * The bundle is hand-written and has no build step that could import
     * `package.json`, so the two are kept in step by hand — this mirrors the
     * `repository` field there.
     */
    const REPO_SLUG = 'lolkda/dsh-prompt-manager'
    const REPO_URL = `https://github.com/${REPO_SLUG}`

    // Every value below is copied from the shell's own settings pages — the
    // plugin page (heading/intro/tab row/card list) and the model page (row
    // card, chip, row buttons, dashed add buttons, status dot) — so this section
    // sits in the same visual language, and in the same theme, as the pages it
    // appears beside. Only aliases that exist in the shell's theme are used: an
    // unknown custom property would silently fall back and leave the element
    // unstyled.
    const CSS = `
.dsh-prompt-manager{max-width:760px;min-width:0;display:flex;flex-direction:column;gap:12px;padding-bottom:12px;color:var(--dsw-alias-label-primary)}
.dsh-prompt-manager__heading{margin:0;font-size:18px;font-weight:600}
.dsh-prompt-manager__intro{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dsh-prompt-manager__note{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dsh-prompt-manager__status{margin:0;font-size:12px;line-height:1.5}
.dsh-prompt-manager__status--error{color:var(--dsw-alias-label-error)}
.dsh-prompt-manager__status--ok{color:var(--dsw-alias-state-success-primary)}
.dsh-prompt-manager__block{display:flex;flex-direction:column;gap:12px;min-width:0}
.dsh-prompt-manager__head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.dsh-prompt-manager__headTitle{margin:0;font-size:18px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-prompt-manager__headSpacer{flex:1 1 auto}

/* the tab row: plain labels, the active one underlined, hairline underneath */
.dsh-prompt-manager__tabs{display:flex;align-items:flex-end;gap:22px;margin-top:2px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsh-prompt-manager__tab{position:relative;background:0 0;border:0;padding:7px 1px 9px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsh-prompt-manager__tab:hover{color:var(--dsw-alias-label-primary)}
.dsh-prompt-manager__tab--active{color:var(--dsw-alias-label-primary)}
.dsh-prompt-manager__tab--active:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-label-primary)}

/* one card per entry, matching the model page's row card */
.dsh-prompt-manager__list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;min-width:0}
.dsh-prompt-manager__card{display:flex;align-items:center;gap:10px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;min-width:0}
.dsh-prompt-manager__cardBody{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-prompt-manager__cardMain{flex:1 1 auto;display:flex;flex-direction:column;gap:2px;min-width:0;margin:0;padding:0;background:0 0;border:0;text-align:left;color:inherit;font:inherit;cursor:pointer}
.dsh-prompt-manager__cardMain:disabled{cursor:default}
.dsh-prompt-manager__cardSide{display:inline-flex;align-items:center;gap:8px;margin-left:auto;flex:0 0 auto}
.dsh-prompt-manager__title{font-size:14px;font-weight:500;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-prompt-manager__meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-prompt-manager__sourceLink{color:var(--dsw-alias-link);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.dsh-prompt-manager__sourceLink:hover{color:var(--dsw-alias-label-primary)}
.dsh-prompt-manager__iconButton{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:14px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-prompt-manager__iconButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-prompt-manager__inlineMenu{display:flex;flex-direction:column;gap:2px;padding:6px;margin:0 0 6px 28px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px}
.dsh-prompt-manager__inlineMenu button{background:0 0;border:0;padding:6px 8px;border-radius:8px;text-align:left;color:inherit;font:inherit;font-size:13px;cursor:pointer}
.dsh-prompt-manager__inlineMenu button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-prompt-manager__inlineMenu button:disabled{color:var(--dsw-alias-label-quaternary);cursor:default}

/* chip and status dot, as on the model page */
.dsh-prompt-manager__badge{flex:0 0 auto;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
/* The compaction badge marks a different claim from the subscribed one — the
   entry is not a system prompt section at all — so it carries its own class and
   a quieter border rather than the same look twice. */
.dsh-prompt-manager__badge--compaction{border-style:dashed;color:var(--dsw-alias-label-tertiary)}
.dsh-prompt-manager__dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-state-success-primary)}
.dsh-prompt-manager__dot--idle{background:var(--dsw-alias-label-quaternary)}
.dsh-prompt-manager__dot--pending{background:var(--dsw-alias-state-warn-primary)}
.dsh-prompt-manager__dot--error{background:var(--dsw-alias-state-error-primary)}

/* buttons: the shell's own settings pages hand-roll these three shapes */
.dsh-prompt-manager__button{box-sizing:border-box;height:28px;padding:0 10px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:14px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer}
.dsh-prompt-manager__button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-prompt-manager__button:disabled{color:var(--dsw-alias-label-quaternary);border-color:var(--dsw-alias-border-l4);cursor:default}
.dsh-prompt-manager__button--primary{height:32px;padding:0 14px;border-radius:16px;border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-size:13px}
.dsh-prompt-manager__button--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsh-prompt-manager__button--primary:disabled{background:var(--dsw-alias-button-primary-dimmed);color:var(--dsw-alias-label-quaternary)}
.dsh-prompt-manager__button--danger{color:var(--dsw-alias-state-error-primary)}
.dsh-prompt-manager__button--danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsh-prompt-manager__button--ghost{border-color:transparent;color:var(--dsw-alias-label-secondary)}
/* A fixed two-column grid rather than flex-wrap with a min-width. That layout's
   wrap threshold (3 x 180px + 2 x 10px = 560px) sat within a few pixels of this
   panel's own width, so a scrollbar or a window a few pixels narrower re-flowed
   the row: the same page offered three controls per line in one visit and two in
   the next. A fixed track count depends on nothing. */
.dsh-prompt-manager__addRow{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
/* A last control with no partner takes the whole width instead of the left half. */
.dsh-prompt-manager__addRow>:last-child:nth-child(odd){grid-column:1/-1}
.dsh-prompt-manager__addButton{height:44px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px dashed var(--dsw-alias-border-l3);border-radius:16px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.dsh-prompt-manager__addButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-prompt-manager__addButton:disabled{color:var(--dsw-alias-label-quaternary);cursor:default}
/* The import control is a real file input behind the same dashed pill, so the
   picker opens natively and the browser keeps its own file-selection UI. */
.dsh-prompt-manager__fileLabel{cursor:pointer}
.dsh-prompt-manager__fileLabel[aria-disabled='true']{color:var(--dsw-alias-label-quaternary);cursor:default}
.dsh-prompt-manager__fileInput{display:none}

/* surfaces and fields */
.dsh-prompt-manager__surface{display:flex;flex-direction:column;gap:14px;padding:14px 16px;border-radius:12px;background:var(--dsw-alias-bg-module-platform);min-width:0}
.dsh-prompt-manager__fields{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;min-width:0}
.dsh-prompt-manager__field{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dsh-prompt-manager__field--grow{flex:1 1 200px}
.dsh-prompt-manager__field--order{flex:0 0 96px}
/* The combo editor's compaction control is a native select, and it should look
   like the text fields beside it rather than like a browser default. */
.dsh-prompt-manager__field input,.dsh-prompt-manager__field select{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dsh-prompt-manager__field input:focus,.dsh-prompt-manager__field select:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dsh-prompt-manager__field input:disabled,.dsh-prompt-manager__field select:disabled{color:var(--dsw-alias-label-quaternary)}
.dsh-prompt-manager__pane{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsh-prompt-manager__paneLabel{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dsh-prompt-manager__pane textarea{box-sizing:border-box;width:100%;min-height:300px;resize:vertical;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px}
.dsh-prompt-manager__pane textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dsh-prompt-manager__preview{box-sizing:border-box;width:100%;max-height:320px;overflow:auto;padding:12px;border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;overflow-wrap:anywhere}
.dsh-prompt-manager__preview pre{white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-prompt-manager__preview code{overflow-wrap:anywhere}
.dsh-prompt-manager__preview>*{max-width:100%}
.dsh-prompt-manager__previewRaw{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px}
.dsh-prompt-manager__actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.dsh-prompt-manager__empty{margin:0;padding:12px;border:1px dashed var(--dsw-alias-border-l3);border-radius:8px;text-align:center;font-size:13px;color:var(--dsw-alias-label-tertiary)}

/* one card per subscription source */
.dsh-prompt-manager__source{display:flex;flex-direction:column;gap:12px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;min-width:0}
.dsh-prompt-manager__sourceHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.dsh-prompt-manager__sourceFoot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.dsh-prompt-manager__sourceRepo{font-size:14px;font-weight:500;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-prompt-manager__sourceActions{display:inline-flex;align-items:center;gap:4px;margin-left:auto}
.dsh-prompt-manager__changes{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-module-platform);min-width:0}
.dsh-prompt-manager__change{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;min-width:0}
.dsh-prompt-manager__changePath{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px}
.dsh-prompt-manager__delta{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}

/* one combo's member checklist */
.dsh-prompt-manager__members{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-module-platform);min-width:0;max-height:320px;overflow:auto}
.dsh-prompt-manager__member{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;min-width:0}
.dsh-prompt-manager__memberLabel{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-prompt-manager__memberId{flex:0 0 auto;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary)}

/* the composer chip: one compact control in the tool row below the input box */
.dsh-prompt-manager__composerChip{box-sizing:border-box;max-width:240px;height:28px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;border:0;border-radius:14px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;white-space:nowrap;overflow:hidden;cursor:pointer}
.dsh-prompt-manager__composerChip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-prompt-manager__composerChip--on{color:var(--dsw-alias-label-primary)}
.dsh-prompt-manager__composerChipLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* the shell marks keyboard focus with a 2px business-colour ring; keep that */
.dsh-prompt-manager__tab:focus-visible,.dsh-prompt-manager__button:focus-visible,.dsh-prompt-manager__addButton:focus-visible,.dsh-prompt-manager__cardMain:focus-visible,.dsh-prompt-manager__iconButton:focus-visible,.dsh-prompt-manager__composerChip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
`.trim()

    /**
     * Request one Host route.
     * @param method - HTTP method.
     * @param path - path below {@link ROUTE}, leading slash included.
     * @param payload - JSON body to send, when the method takes one.
     * @returns the parsed JSON response.
     */
    async function request(method, path, payload) {
      const init = { method }
      if (payload !== undefined) {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(payload)
      }
      const response = await fetch(ROUTE + path, init)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = data && typeof data.error === 'string' ? data.error : `${method} ${path} failed (${response.status})`
        const error = new Error(detail)
        error.status = response.status
        // Which rule refused it, when the Host named one: the page answers in its
        // own words per code instead of quoting the Host's English sentence.
        error.code = data && typeof data === 'object' && typeof data.code === 'string' ? data.code : undefined
        // A refused save carries the run that refused it, so the editor can show
        // what the script actually printed rather than only that it was refused.
        error.report = data && typeof data === 'object' ? data.report : undefined
        throw error
      }
      return data
    }

    /**
     * Why the store could not be read, in the page's own words.
     *
     * The Host names the rule it applied; quoting its English sentence at a
     * person reading a Chinese page explains nothing, and saying nothing at all
     * leaves them with an empty panel and no idea which side to fix.
     */
    const STORE_REFUSALS = {
      'no-session': 'このページにはブラウザセッションがありません。dsh web が出力したアドレスでもう一度開いてください。',
      'host-not-trusted': 'このアドレスはデプロイに信頼されていません。trustedHosts に追加するか、ローカルアドレスで開いてください。',
      'no-trust-authority': 'このプリセットには Connection が紐づいていないため、プロンプトストアはローカル専用です。このページをローカルで開いてください。',
      'host-not-loopback': 'プロンプトストアはローカルホスト名のみ受け付けます（127.0.0.1 / localhost / [::1]）。',
    }

    /** Where a variable's value came from, in the page's own words. */
    const SOURCE_LABELS = { environment: 'システム', config: '設定', probe: 'プローブ', script: 'スクリプト', dsh: 'DSH ネイティブ' }

    /** Valid variable names, mirroring the registry's own rule. */
    const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

    /**
     * The source a brand-new script starts from.
     *
     * It runs as it stands — printing a JSON object whose keys become variable
     * names — so the first thing a person sees is a working example rather than
     * an empty box and a paragraph explaining what to type.
     */
    /**
     * The source a new script starts from.
     *
     * It runs as it stands, and its one key is deliberately not a name the
     * plugin already provides (`pwsh` / `bash` / `git` / `node` / `python` and
     * the four environment facts): a template that claims one of those would be
     * refused on save, and one that claims an arbitrary tool would leave a
     * `(not installed)` variable behind on every machine that lacks it.
     */
    const SCRIPT_TEMPLATE = [
      '// JSON オブジェクトを出力します。キーがプロンプトで使える変数名 {{name}} になります。',
      '// このスクリプトは独立した子プロセスで動きます。タイムアウトやエラーが発生しても DSH 本体に影響しません。',
      'const { execSync } = require("node:child_process")',
      '',
      'const firstLine = (command) => {',
      '  try {',
      '    return execSync(command, { encoding: "utf8" }).trim().split("\\n")[0]',
      '  } catch {',
      '    return "(not installed)"',
      '  }',
      '}',
      '',
      'console.log(JSON.stringify({',
      '  // 探知したい内容に書き換えてください。1行に1つの変数を記述します。例：',
      '  //   toolchain_java: firstLine("java -version"),',
      '  node_version: process.version.replace(/^v/, ""),',
      '}))',
      '',
    ].join('\n')

    // A brand-new compaction instruction starts empty, on purpose.
    //
    // The instruction it replaces is DSH's own, and that text is not readable from
    // here; any copy shipped as a starting point would be this page guessing at
    // another package's wording, and would rot the moment that package changed it.
    // (It also cannot round-trip: a reference-shaped literal in such a copy is
    // refused by the same validator a body goes through.) Empty is the honest
    // state as well — with no body the pointer falls back to DSH's own
    // instruction, so a draft that says nothing cannot change what the summarizer
    // is told.

    /** Title a freshly created compaction entry is given. */
    const COMPACTION_TITLE = '圧縮命令'

    /**
     * Every `{{...}}` a body carries, as written.
     *
     * The inner text is returned whatever it holds, because the point of this
     * scan is to catch a reference that would fail assembly — and a name that is
     * not a valid variable name fails it just as hard as one that is not
     * registered.
     * @param text - markdown body.
     * @returns the reference texts, in order, without repeats.
     */
    function referencesIn(text) {
      const found = []
      const pattern = /\{\{([^{}]*)\}\}/g
      let match = pattern.exec(text)
      while (match !== null) {
        if (!found.includes(match[1])) found.push(match[1])
        match = pattern.exec(text)
      }
      return found
    }

    /**
     * A stored timestamp as the page shows it: local time, falling back to the
     * raw value when it cannot be parsed (an empty string means "never").
     * @param value - ISO-8601 text from the Host.
     * @returns the text to render.
     */
    function stamp(value) {
      const parsed = new Date(value)
      return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
    }

    /**
     * Whether a script source parses, checked here so the editor can say so
     * while somebody types. The Host re-checks before writing, and this is only
     * ever a hint: a browser without `new Function` simply reports nothing.
     * @param source - script text.
     * @returns the parser's complaint, or `null` when it parses.
     */
    function syntaxProblem(source) {
      try {
        // The compilation is what is wanted here, never the call.
        Function(source)
        return null
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        // A host that forbids eval refuses the compilation itself. That is not a
        // syntax error, so the editor says nothing rather than something wrong.
        if (error && (error.name === 'EvalError' || /Content Security Policy|unsafe-eval/i.test(message))) return null
        return message
      }
    }

    /** Read the entry index out of a settings snapshot. */
    function entriesOf(snapshot) {
      const value = snapshot && snapshot.value
      const list = value && Array.isArray(value.entries) ? value.entries : []
      return list.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
    }

    /** Read the configured subscriptions out of a settings snapshot. */
    function sourcesOf(snapshot) {
      const value = snapshot && snapshot.value
      const list = value && Array.isArray(value.sources) ? value.sources : []
      return list.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
    }

    /**
     * Read the configured presets out of a settings snapshot.
     *
     * Normalized the same way {@link sourcesOf} is, because this feeds a control
     * that renders on the composer: a hand-edited document must not be able to
     * make the chip throw where the input box lives.
     * @param snapshot - the settings snapshot.
     * @returns one record per preset, with a display name and a member list.
     */
    function presetsOf(snapshot) {
      const value = snapshot && snapshot.value
      const list = value && Array.isArray(value.presets) ? value.presets : []
      const compressionIds = new Set(entriesOf(snapshot).filter(isCompaction).map((entry) => entry.id))
      return list
        .filter((preset) => preset !== null && typeof preset === 'object' && typeof preset.id === 'string')
        .map((preset) => ({
          id: preset.id,
          name: typeof preset.name === 'string' && preset.name.length > 0 ? preset.name : preset.id,
          entries: Array.isArray(preset.entries)
            ? preset.entries.filter((id) => typeof id === 'string' && !compressionIds.has(id))
            : [],
        }))
    }

    /** Whether two preset lists differ in anything the Host stores. */
    function presetsDiffer(before, after) {
      if (before.length !== after.length) return true
      for (let index = 0; index < before.length; index += 1) {
        const left = before[index]
        const right = after[index]
        if (left.id !== right.id || left.name !== right.name) return true
        if (left.entries.length !== right.entries.length) return true
        for (let member = 0; member < left.entries.length; member += 1) {
          if (left.entries[member] !== right.entries[member]) return true
        }
      }
      return false
    }

    /**
     * The paths a check staged, whatever shape the answer arrived in.
     *
     * A proxy that answers with something that is not the Host's JSON would
     * otherwise turn every consumer of the outcome into a `TypeError`, which the
     * page can only report as gibberish.
     * @param outcome - the check answer.
     * @returns the staged paths, or an empty list.
     */
    function changedPaths(outcome) {
      const changes = outcome && Array.isArray(outcome.changes) ? outcome.changes : []
      return changes
        .map((change) => (change !== null && typeof change === 'object' ? change.path : undefined))
        .filter((path) => typeof path === 'string')
    }

    /**
     * Whether an entry came from a subscription.
     *
     * Tested by value, not by presence: the settings schema resolves a missing
     * source to an empty string, so `'source' in entry` is true for every local
     * entry as well — which used to badge them all as subscribed.
     */
    function isSubscribed(entry) {
      return typeof entry.source === 'string' && entry.source.length > 0
    }

    /**
     * Whether an entry is the compaction instruction rather than a section.
     *
     * The field is absent on a section entry by design — writing `kind:
     * 'section'` back would leave a phantom key in every record of the settings
     * document — so absence, not the literal value, is what a section means.
     */
    function isCompaction(entry) {
      return entry.kind === 'compaction'
    }

    /** The next free placement for an added entry. */
    function nextOrder(entries) {
      let highest = 0
      for (const entry of entries) if (typeof entry.order === 'number' && entry.order > highest) highest = entry.order
      return highest + 10
    }

    /** Whether two indexes differ in anything the Host stores. */
    function indexChanged(before, after) {
      if (before.length !== after.length) return true
      for (let index = 0; index < before.length; index += 1) {
        const left = before[index]
        const right = after[index]
        if (left.id !== right.id || left.title !== right.title || left.order !== right.order || left.enabled !== right.enabled) return true
      }
      return false
    }

    /** One shell icon, or nothing when that primitive is missing. */
    /**
     * Whether a primitives export can be rendered.
     *
     * React's `memo` and `forwardRef` return objects rather than functions — the
     * shell's `MarkdownText` is a `memo` — so a `typeof === 'function'` check
     * silently drops exactly the primitive a bundle most wants and degrades to
     * plain text. Anything React can mount is accepted here.
     */
    function isComponent(value) {
      if (typeof value === 'function') return true
      return typeof value === 'object' && value !== null && typeof value.$$typeof === 'symbol'
    }

    /** One shell icon, or nothing when that primitive is missing. */
    function icon(name) {
      const component = primitives[name]
      return isComponent(component) ? h(component, {}) : undefined
    }

    /** A switch control, falling back to a checkbox on a host without the primitive. */
    function Switch(props) {
      if (isComponent(primitives.Switch)) {
        return h(primitives.Switch, {
          checked: props.checked,
          label: props.label,
          disabled: props.disabled,
          onChange: props.onChange,
        })
      }
      return h('input', {
        type: 'checkbox',
        checked: props.checked,
        disabled: props.disabled,
        'aria-label': props.label,
        onChange: props.onChange,
      })
    }

    /**
     * One button, drawn in the shape the shell's own settings pages use: a
     * hairline outline by default, a filled primary, a borderless ghost, and a
     * danger label that turns red on hover. The shell's `Button` primitive is the
     * larger, dialog-sized control, which is why the settings pages hand-roll
     * these instead — this section follows them so it looks like a sibling page.
     * @param props - label, variant, disabled flag, and click handler.
     */
    function Button(props) {
      const variant = props.variant ?? 'secondary'
      return h('button', {
        type: 'button',
        className: `dsh-prompt-manager__button dsh-prompt-manager__button--${variant}`,
        disabled: props.disabled,
        onClick: props.onClick,
      }, props.children)
    }

    /**
     * One dashed "add something" control, the shape the shell puts under a list.
     * @param props - label, disabled flag, click handler, and an optional glyph.
     */
    function AddButton(props) {
      return h('button', {
        type: 'button',
        className: 'dsh-prompt-manager__addButton',
        disabled: props.disabled,
        onClick: props.onClick,
      }, [
        icon(props.icon ?? 'IconPlusOutline16') ?? h('span', { key: 'glyph' }, '＋'),
        h('span', { key: 'label' }, props.children),
      ])
    }

    /**
     * A menu over the shell's `Menu`, anchored to a control of the caller's
     * choosing, with an inline list as the fallback for a host that predates that
     * primitive.
     * @param props - open state, items, selection handler, label, and anchor node.
     */
    function SlotMenu(props) {
      if (isComponent(primitives.Menu)) {
        return h(primitives.Menu, {
          open: props.open,
          onClose: props.onClose,
          items: props.items,
          onSelect: props.onSelect,
          // Portal: the settings panel scrolls, and a menu rendered inside it
          // would be clipped by the panel's own overflow — and the composer's own
          // stacking is no more forgiving.
          portal: true,
          closeOnPointerLeave: true,
          anchor: props.anchor,
        })
      }
      if (!props.open) return props.anchor
      return h(React.Fragment, null, props.anchor, h('div', { className: 'dsh-prompt-manager__inlineMenu' },
        props.items.map((item) => h('button', {
          key: item.id,
          type: 'button',
          disabled: item.disabled === true,
          onClick: () => props.onSelect(item.id),
        }, item.label))))
    }

    /**
     * A kebab menu over {@link SlotMenu}: the row action control the list pages
     * use.
     * @param props - open state, items, selection handler, and accessibility label.
     */
    function RowMenu(props) {
      const anchor = h('button', {
        type: 'button',
        className: 'dsh-prompt-manager__iconButton',
        'aria-label': props.label,
        'aria-haspopup': 'menu',
        'aria-expanded': props.open,
        onClick: (event) => {
          event.stopPropagation()
          props.onToggle()
        },
      }, icon('IconEllipsisOutline16') ?? '⋯')

      return h(SlotMenu, { ...props, anchor })
    }

    /** Markdown preview over the shell's own renderer. */
    function Preview(props) {
      if (props.text.length === 0) return h('div', { className: 'dsh-prompt-manager__empty' }, '（本文が空です：このエントリは何も注入しません）')
      if (isComponent(primitives.MarkdownText)) {
        return h(primitives.MarkdownText, {
          text: props.text,
          streaming: false,
          labels: { code: { copyLabel: 'コピー', copiedLabel: 'コピーしました' }, footnotes: 'フッター' },
        })
      }
      // Last resort on a host without the primitive: the raw source, clearly
      // marked as unrendered so it cannot be mistaken for a real preview.
      return h('pre', { className: 'dsh-prompt-manager__previewRaw' }, props.text)
    }

    /**
     * What one script run produced, as the editor shows it.
     *
     * A test run is the same execution a save performs, so this is not a
     * simulation: it is the variables the script would supply, the exit code it
     * exited with, and everything that went wrong — which is exactly what a
     * person needs before deciding to save.
     * @param props - the run report, or null when nothing has been run.
     */
    function RunReport(props) {
      const report = props.report
      if (report === null || report === undefined) return null
      const names = report.variables === undefined || report.variables === null ? [] : Object.keys(report.variables)
      return h('div', { className: 'dsh-prompt-manager__changes' }, [
        h('span', {
          key: 'head',
          className: report.ok === true
            ? 'dsh-prompt-manager__status dsh-prompt-manager__status--ok'
            : 'dsh-prompt-manager__status dsh-prompt-manager__status--error',
        }, [
          report.ok === true ? `今回の実行で ${String(names.length)} 個の変数が提供されました` : '今回の実行で使える変数は出力されませんでした',
          `終了コード ${report.exitCode === undefined ? 'なし' : String(report.exitCode)}`,
          `${String(report.ms)}ms`,
        ].join(' · ')),
        ...names.map((name) => h('div', { key: name, className: 'dsh-prompt-manager__change' }, [
          h('span', { key: 'token', className: 'dsh-prompt-manager__changePath' }, `{{${name}}}`),
          h('span', { key: 'value', className: 'dsh-prompt-manager__delta' }, report.variables[name]),
        ])),
        ...(report.problems ?? []).map((problem, index) => h('span', {
          key: `problem-${String(index)}`,
          className: 'dsh-prompt-manager__status dsh-prompt-manager__status--error',
        }, problem)),
        ...(report.warnings ?? []).map((warning, index) => h('span', {
          key: `warning-${String(index)}`,
          className: 'dsh-prompt-manager__note',
        }, warning)),
        typeof report.stderr === 'string' && report.stderr.length > 0
          ? h('pre', { key: 'stderr', className: 'dsh-prompt-manager__previewRaw' }, report.stderr)
          : null,
      ])
    }

    /** What a session that has chosen nothing gets: no preset, DSH's own instruction. */
    const EMPTY_CHOICE = { preset: '', compaction: '' }

    /**
     * The text one failed request is reported as.
     *
     * The Host names the rule it refused with; quoting its English sentence at a
     * person reading a Chinese page explains nothing, so a known code is said in
     * the page's own words. Anything else — a save refused for a stale hash, a
     * script that would not run — already comes back in the language the page is
     * written in, and is passed through.
     *
     * @param error - whatever the failed call rejected with.
     * @returns a sentence for a person.
     */
    function failureText(error) {
      const known = STORE_REFUSALS[error?.code]
      if (known !== undefined) return known
      return error && error.message ? error.message : String(error)
    }

    /**
     * What to say when a settings write was not accepted.
     *
     * A write that did not land is not a failure to explain away: the value the
     * person asked for is not confirmed, and the page must say which part did not
     * land rather than reporting the change it did not make. `what` names that part
     * in the page's own words, because the sentence before the colon differs at
     * every call site — a toggle, a body that is already on disk, a preset list —
     * while the reason and the way out are the same.
     *
     * @param what - the part that did not land.
     * @returns a sentence for a person.
     */
    function refusalText(what) {
      return `${what}：ホストがこの保存を受け付けませんでした（このページが読んだバージョンが古いか、書き込み権限がありません）。もう一度試してください。`
    }

    /**
     * Write one settings field and report whether the Host accepted it.
     *
     * The published peer is DSH 0.1.7-rc.1, whose form answers a boolean: `true`
     * only for a write the Host accepted, `false` for one it refused (it rejects
     * nothing, and a memory-mode form answers `false` too). Every write in this
     * bundle goes through here, so exactly one place decides what "accepted" means
     * and no caller can mistake anything else for a save — including the silence of
     * a form that answers no verdict at all, which is outside the contract and is
     * never read as a save.
     *
     * @param form - this plugin's settings form.
     * @param field - the field to write.
     * @param value - the complete next value of that field.
     * @returns whether the Host accepted the write.
     */
    async function accepted(form, field, value) {
      return (await form.set(field, value)) === true
    }

    /**
     * One session's stored choice, and the way to change it.
     *
     * The choice is a file the Host owns, one per session, so this is a request
     * rather than a settings read: the settings namespace holds the catalog every
     * session picks from, and a pick made in one conversation must not reach
     * another.
     *
     * The id itself is not looked up here. `conversation.input.right` is declared a
     * session-scoped slot, so the renderer hands every entry the conversation the
     * composer is drawn for — as the `sessionId` prop, from the `ui-session`
     * standard source, per render occurrence. That is the seam this plugin is
     * meant to use, and it has carried the id since 0.1.5.
     *
     * 3.2.1 read it from the session list's snapshot instead — the `current` field
     * of that snapshot, which the list no longer carries. DSH 0.1.6 dropped it, so
     * every chip got `undefined`: the menu still opened, every preset item came
     * out `disabled`, and clicking one did nothing — which is exactly what
     * "プロンプトを切り替えられません" looked like.
     * @param sessionId - the conversation to read and write.
     * @returns the choice in force, the last failure, and the writer.
     */
    function useSessionChoice(sessionId) {
      const [state, setState] = React.useState({ value: EMPTY_CHOICE, failed: null })
      const narrow = (payload) => ({
        preset: payload && typeof payload.preset === 'string' ? payload.preset : '',
        compaction: payload && typeof payload.compaction === 'string' ? payload.compaction : '',
      })
      React.useEffect(() => {
        if (sessionId === undefined) {
          setState({ value: EMPTY_CHOICE, failed: null })
          return undefined
        }
        let live = true
        setState({ value: EMPTY_CHOICE, failed: null })
        request('GET', `/session/${encodeURIComponent(sessionId)}`)
          .then((payload) => { if (live) setState({ value: narrow(payload), failed: null }) })
          .catch((error) => { if (live) setState({ value: EMPTY_CHOICE, failed: failureText(error) }) })
        return () => { live = false }
      }, [sessionId])
      // The answer is the stored choice, so the chip shows what the Host will act
      // on rather than what the page hoped it would.
      const write = (patch) => {
        if (sessionId === undefined) return
        request('POST', `/session/${encodeURIComponent(sessionId)}`, patch)
          .then((payload) => { setState({ value: narrow(payload), failed: null }) })
          .catch((error) => { setState((previous) => ({ ...previous, failed: failureText(error) })) })
      }
      return { value: state.value, failed: state.failed, write }
    }

    /**
     * The composer chip: which prompt preset is in force, and the control that
     * switches it.
     *
     * It rides the composer tool row so the set can be swapped from beside the
     * input box instead of through Settings. The *catalog* it offers comes from the
     * settings namespace — the presets, and a change made on the settings page
     * shows up here with no wiring of its own — while which one is in force is read
     * from this conversation's own file, named by the id the slot hands this chip.
     * So a switch here is one small request that the next model step honours, and
     * no other conversation feels it.
     * @param props - composed slot props: the bound settings scope, and the
     * `sessionId` standard prop of the session-scoped slot this chip fills.
     * @returns the chip element tree.
     */
    function PresetChip(props) {
      const scope = props.scope
      const subscribe = React.useCallback((listener) => scope.subscribe(listener), [scope])
      const getSnapshot = React.useCallback(() => scope.getSnapshot(), [scope])
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const presets = React.useMemo(() => presetsOf(snapshot), [snapshot])
      // Which conversation this chip speaks for. The slot is session-scoped, so the
      // framework resolved it before rendering: no lookup, and no way to read some
      // other conversation's answer.
      const sessionId = props.sessionId
      const session = useSessionChoice(sessionId)
      // The preset in force for this session, named by its own file. An id that
      // names nothing — a preset somebody just deleted — reads as no preset,
      // which is what the Host does with it too.
      const active = presets.find((preset) => preset.id === session.value.preset) ?? null
      const [open, setOpen] = React.useState(false)

      // Nothing to say until the namespace has answered, and nothing to offer on
      // a host that does not serve it at all.
      if (snapshot.status !== 'ready') return null

      const writable = snapshot.writable !== false && snapshot.mode !== 'memory'
      const current = session.value.preset.length === 0 ? NO_PRESET : session.value.preset
      const items = presets.length === 0
        ? [{ id: 'no-presets', label: 'プリセットがありません。設定 → プロンプト → プリセット で新規作成してください', disabled: true }]
        : [
          // Every item is refused together while the page cannot write: "back to the
          // per-entry switches" is a write like any other, and letting that one
          // through only turns a disabled control into a failure message.
          { id: NO_PRESET, label: `プリセット不使用（エントリごとのトグル）${current === NO_PRESET ? '（現在）' : ''}`, disabled: !writable },
          ...presets.map((preset) => ({
            id: preset.id,
            label: `${preset.name}（${String(preset.entries.length)} 件）${current === preset.id ? '（現在）' : ''}`,
            disabled: !writable,
          })),
        ]

      const choose = (id) => {
        setOpen(false)
        if (id === current || id === 'no-presets') return
        // Each control owns one field. A preset selects sections only; changing
        // or cancelling it must preserve the session's manual compression choice.
        session.write({ preset: id })
      }

      return h(SlotMenu, {
        open,
        items,
        onClose: () => setOpen(false),
        onSelect: choose,
        anchor: h('button', {
          type: 'button',
          className: session.value.preset.length === 0
            ? 'dsh-prompt-manager__composerChip'
            : 'dsh-prompt-manager__composerChip dsh-prompt-manager__composerChip--on',
          'aria-label': 'このセッションのプロンプトプリセットを切り替え',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          title: session.failed !== null
            ? `切り替え失敗：${session.failed}`
            : writable
              ? 'このセッションのプロンプトプリセットを切り替えます（次のモデルステップから有効、他のセッションには影響しません）'
              : 'このページは読み取り専用です。LAN アドレスで開いたため、設定チャネルがメモリモードに退化しています',
          onClick: () => setOpen((wasOpen) => !wasOpen),
        }, h('span', { className: 'dsh-prompt-manager__composerChipLabel' },
          session.failed !== null ? 'プロンプト · 切り替え失敗' : `プロンプト · ${active === null ? 'トグルごと' : active.name}`)),
      })
    }

    /**
     * The compaction chip: which compaction instruction runs, and the control that
     * switches it.
     *
     * The twin of the preset chip beside it — same row, same one-request shape —
     * answering the other half of the question. That chip decides which sections go
     * into the prompt; this one decides which instruction replaces DSH's own when a
     * context compaction summarises the conversation.
     *
     * It writes this session's own file. The instruction belongs to the conversation,
     * not to the deployment: two conversations may summarise against two different
     * templates, and choosing one here cannot change what another one sends.
     * @param props - composed slot props: the bound settings scope, and the
     * `sessionId` standard prop of the session-scoped slot this chip fills.
     * @returns the chip element tree.
     */
    function CompactionChip(props) {
      const scope = props.scope
      const subscribe = React.useCallback((listener) => scope.subscribe(listener), [scope])
      const getSnapshot = React.useCallback(() => scope.getSnapshot(), [scope])
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const entries = React.useMemo(() => entriesOf(snapshot), [snapshot])
      // Same seam as the chip beside it: the slot is session-scoped, so the id of the
      // conversation being drawn for arrives as a prop rather than from a lookup.
      const sessionId = props.sessionId
      const session = useSessionChoice(sessionId)
      const [open, setOpen] = React.useState(false)

      // Nothing to say until the namespace has answered, and nothing to offer on a host
      // that does not serve it at all.
      if (snapshot.status !== 'ready') return null

      const writable = snapshot.writable !== false && snapshot.mode !== 'memory'
      const choices = entries.filter((entry) => isCompaction(entry))
      // What the Host will actually use: this session's own choice and nothing else.
      // An id that names nothing — a section, or an entry that has since been deleted
      // — reads as no instruction at all, which is exactly what `resolveCompaction`
      // does with it, so the chip can never claim an instruction the next compaction
      // will not send.
      const current = session.value.compaction
      const chosen = choices.find((entry) => entry.id === current) ?? null
      const items = choices.length === 0
        ? [{ id: 'no-entries', label: '圧縮命令がありません。設定 → プロンプト → 圧縮命令を追加 してください', disabled: true }]
        : [
          // Refused together with the rest while the page cannot write, for the same
          // reason as the preset chip's no-preset item: going back to DSH's own
          // instruction is a write too.
          { id: NO_PRESET, label: `不使用：DSH 内蔵の圧縮命令${current === NO_PRESET ? '（現在）' : ''}`, disabled: !writable },
          ...choices.map((entry) => ({
            id: entry.id,
            label: `${entry.title}${current === entry.id ? '（現在）' : ''}`,
            disabled: !writable,
          })),
        ]

      const choose = (id) => {
        setOpen(false)
        if (id === current || id === 'no-entries') return
        // One field of one session's file, patched rather than replaced: the preset
        // that session is using stays exactly as it is.
        session.write({ compaction: id })
      }

      return h(SlotMenu, {
        open,
        items,
        onClose: () => setOpen(false),
        onSelect: choose,
        anchor: h('button', {
          type: 'button',
          className: chosen === null
            ? 'dsh-prompt-manager__composerChip'
            : 'dsh-prompt-manager__composerChip dsh-prompt-manager__composerChip--on',
          'aria-label': '圧縮命令を切り替え',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          title: session.failed !== null
            ? `切り替え失敗：${session.failed}`
            : !writable
              ? 'このページは読み取り専用です。LAN アドレスで開いたため、設定チャネルがメモリモードに退化しています'
              : 'このセッションの圧縮命令を切り替えます（次回の圧縮から有効、他のセッションには影響しません）',
          onClick: () => setOpen((wasOpen) => !wasOpen),
        }, h('span', { className: 'dsh-prompt-manager__composerChipLabel' },
          session.failed !== null ? '圧縮 · 切り替え失敗' : `圧縮 · ${chosen === null ? 'DSH デフォルト' : chosen.title}`)),
      })
    }

    /**
     * Render the settings section: the entry list, the editor page, or the
     * subscription sources.
     * @param props - composed slot props carrying the bound settings scope.
     * @returns the section element tree.
     */
    function PromptSection(props) {
      const scope = props.scope
      // The scope's methods read their own state off `this`, so they are bound
      // here instead of being handed to React as bare references.
      const subscribe = React.useCallback((listener) => scope.subscribe(listener), [scope])
      const getSnapshot = React.useCallback(() => scope.getSnapshot(), [scope])
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const entries = React.useMemo(() => entriesOf(snapshot), [snapshot])
      const configured = React.useMemo(() => sourcesOf(snapshot), [snapshot])
      const presets = React.useMemo(() => presetsOf(snapshot), [snapshot])
      // Which preset and which compaction instruction are in force are facts about
      // a *conversation*, not about this deployment, so this page reads neither of
      // them: the document's `activePreset` and root `compaction` fields stopped
      // deciding anything when the per-session store arrived, and a page that
      // reported them would be describing a switch nobody reads.
      const [view, setView] = React.useState('list')
      const [filter, setFilter] = React.useState('all')
      const [selectedId, setSelectedId] = React.useState(null)
      const [menuFor, setMenuFor] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [saved, setSaved] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState(null)
      const [store, setStore] = React.useState(null)
      const [sources, setSources] = React.useState([])
      const [report, setReport] = React.useState(null)
      const [picked, setPicked] = React.useState([])
      const [newRepo, setNewRepo] = React.useState('')
      const [newRef, setNewRef] = React.useState('main')
      const [newMirror, setNewMirror] = React.useState('')
      const [variableReport, setVariableReport] = React.useState(null)
      const [scriptDraft, setScriptDraft] = React.useState(null)
      const [scriptSaved, setScriptSaved] = React.useState(null)
      const [runReport, setRunReport] = React.useState(null)
      const [caret, setCaret] = React.useState(null)
      const [presetDraft, setPresetDraft] = React.useState(null)

      /**
       * The configured sources by slug: a subscribed entry carries its source's
       * slug, not its repository, so the row needs this to link where the body
       * actually comes from.
       */
      const sourceById = React.useMemo(
        () => new Map(configured.map((source) => [source.id, source])),
        [configured],
      )

      const refreshStore = React.useCallback(() => {
        return request('GET', '/status')
          .then((next) => { setStore(next) })
          // "Could not read it" is its own state, not a store with zero
          // everything: a fabricated `writable: false` would disable editing for
          // a store that is perfectly writable, and a fabricated empty index
          // would claim there are no prompts.
          .catch((error) => { setStore({ ok: false, code: error?.code, status: error?.status, error: failureText(error) }) })
      }, [])

      const refreshSources = React.useCallback(() => {
        return request('GET', '/sources')
          .then((next) => { setSources(Array.isArray(next.sources) ? next.sources : []) })
          .catch((error) => { setStatus({ kind: 'error', text: failureText(error) }) })
      }, [])

      /** Read the variables in force and the scripts that supply them. */
      const refreshVariables = React.useCallback(() => {
        return request('GET', '/variables')
          .then((next) => { setVariableReport(next) })
          .catch((error) => {
            setVariableReport({ variables: [], scripts: [], error: failureText(error) })
          })
      }, [])

      React.useEffect(() => {
        void refreshStore()
        void refreshSources()
        void refreshVariables()
      }, [refreshSources, refreshStore, refreshVariables])

      // An unreachable store is not a writable one: leaving the editor lit would
      // let a person type a whole draft and only find out on save.
      const storeUnreachable = store !== null && store.ok === false
      const writable = snapshot.writable !== false && !storeUnreachable && (store === null || store.writable !== false)
      // A brand-new entry has no saved side yet and is therefore always dirty.
      const dirty = draft !== null && (saved === null
        || draft.title !== saved.title || draft.order !== saved.order || draft.body !== saved.body)
      // A subscribed body belongs to upstream: it is shown, never edited here.
      const subscribedDraft = draft !== null && draft.source === 'subscribed'
      // A built-in body ships with the plugin; editing and saving overrides it.
      const builtinDraft = draft !== null && draft.source === 'builtin'
      // A compaction instruction is edited in the same page as a section, but
      // every answer the page gives about it differs: when an edit lands, what
      // its switch would mean, and how it stops being one.
      const compactionDraft = draft !== null && draft.kind === 'compaction'
      // The Host's catalogue includes plugin-owned values and DSH-native context
      // references. It is not the whole runtime registry: another plugin may
      // provide names that only the actual assembly can resolve.
      const variables = variableReport !== null && Array.isArray(variableReport.variables) ? variableReport.variables : []
      const scripts = variableReport !== null && Array.isArray(variableReport.scripts) ? variableReport.scripts : []
      const knownVariables = variables.map((variable) => variable.name)
      // A reference the prompt cannot resolve makes assembly throw, so the body
      // editor says so first: a name that is not registered, and a reference
      // whose shape is not a variable name at all.
      const referencedInDraft = draft === null ? [] : referencesIn(draft.body)
      const unknownInDraft = referencedInDraft.filter((name) => !knownVariables.includes(name) && VARIABLE_NAME.test(name))
      const malformedInDraft = referencedInDraft.filter((name) => !VARIABLE_NAME.test(name))

      /** Load one entry's body and enter the editor page. */
      const open = React.useCallback(async (id) => {
        setBusy(true)
        setSelectedId(id)
        try {
          const body = await request('GET', `/body/${encodeURIComponent(id)}`)
          const known = entries.find((entry) => entry.id === id)
          const next = {
            id,
            title: known !== undefined ? known.title : id,
            order: known !== undefined && typeof known.order === 'number' ? known.order : nextOrder(entries),
            body: typeof body.body === 'string' ? body.body : '',
            source: body.source,
            fileSha1: typeof body.fileSha1 === 'string' ? body.fileSha1 : null,
            isNew: false,
          }
          // What the entry is decides what the page says about it, and kind is
          // part of the record rather than of the body: it is read from the index
          // the page already holds, and set only when it is set — a section entry
          // carries no such key at all.
          if (known !== undefined && isCompaction(known)) next.kind = 'compaction'
          setDraft(next)
          setSaved(next)
          setStatus(null)
          setView('editor')
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
          setDraft(null)
          setSaved(null)
        } finally {
          setBusy(false)
        }
      }, [entries])

      const select = React.useCallback((entry) => {
        if (entry.id === selectedId && view === 'editor') return
        void open(entry.id)
      }, [open, selectedId, view])

      /** Leave the editor page, keeping nothing unsaved. */
      const back = React.useCallback(() => {
        if (draft !== null && dirty && !window.confirm(draft.isNew
          // A draft is named for what it is: the instruction being thrown away is
          // not a prompt entry, and the question should not call it one.
          ? (isCompaction(draft) ? 'この新規圧縮命令を破棄しますか？' : 'この新規プロンプトを破棄しますか？')
          : '未保存の変更を破棄しますか？')) return
        if (draft !== null && draft.isNew) {
          setDraft(null)
          setSaved(null)
          setSelectedId(null)
        } else {
          setDraft(saved)
        }
        setStatus(null)
        setView('list')
      }, [draft, dirty, saved])

      const add = React.useCallback(async () => {
        // The registry keeps a bounded number of sections, so an entry past the
        // cap would save a body and then never reach the prompt. Refusing here is
        // the only place a person can be told why.
        const cap = store !== null && typeof store.maxEntries === 'number' ? store.maxEntries : null
        if (cap !== null && entries.length >= cap) {
          setStatus({ kind: 'error', text: `プロンプトは最大 ${String(cap)} 件です。1件削除するか、使わないエントリを無効化してください（無効化したエントリも枠を占有します）。` })
          return
        }
        setBusy(true)
        try {
          const allocated = await request('POST', '/id', { title: '新規プロンプト' })
          const next = {
            id: allocated.id,
            title: '新規プロンプト',
            order: nextOrder(entries),
            body: '# 新規プロンプト\n\nここに注入するプロンプトの本文を書きます。\n',
            source: 'empty',
            fileSha1: null,
            isNew: true,
          }
          setSelectedId(allocated.id)
          setDraft(next)
          setSaved(null)
          setStatus({ kind: 'info', text: `id ${allocated.id} を割り当てました。保存するとプロンプトに反映されます。` })
          setView('editor')
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [entries, store])

      /**
       * Create a compaction instruction, as a draft, and put it in force on save.
       *
       * A compaction entry is the one thing the pointer may name, so the record and
       * the pointer that names it are written together, at save time, in the only
       * order that works: body, record, pointer. Writing them here instead — which
       * is what this page used to do, because a pointer has to name something that
       * exists — left a blank instruction in the list behind every visit somebody
       * abandoned, and aimed the pointer at it while it was still blank.
       */
      const addCompaction = React.useCallback(async () => {
        const cap = store !== null && typeof store.maxEntries === 'number' ? store.maxEntries : null
        if (cap !== null && entries.length >= cap) {
          setStatus({ kind: 'error', text: `プロンプトは最大 ${String(cap)} 件です。1件削除してから圧縮命令を追加してください。` })
          return
        }
        setBusy(true)
        try {
          const allocated = await request('POST', '/id', { title: COMPACTION_TITLE })
          const next = {
            id: allocated.id,
            title: COMPACTION_TITLE,
            order: nextOrder(entries),
            body: '',
            source: 'empty',
            fileSha1: null,
            isNew: true,
            kind: 'compaction',
          }
          setSelectedId(allocated.id)
          setDraft(next)
          setSaved(null)
          setStatus({
            kind: 'info',
            text: `id ${allocated.id} を割り当てました。保存すると圧縮命令になります（次回の圧縮から有効）。`,
          })
          setView('editor')
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [entries, store])

      const save = React.useCallback(async () => {
        if (draft === null) return
        setBusy(true)
        try {
          const written = await request('PUT', `/body/${encodeURIComponent(draft.id)}`, {
            body: draft.body,
            fileSha1: draft.fileSha1,
          })
          // The body is on disk, so the fence the editor holds has to be the one
          // that write produced — a later save that reused the old hash would be
          // refused as stale, and the editor would be stuck on 409.
          const placed = {
            ...draft,
            source: typeof written.source === 'string' ? written.source : draft.source,
            fileSha1: typeof written.fileSha1 === 'string' ? written.fileSha1 : null,
          }
          // `isNew` means "this page made it and the index does not carry it yet",
          // so it is cleared only once the index write is accepted. Clearing it
          // here instead would make a refused index write permanent: the retry
          // would look the id up in a list that never got it, find nothing to
          // update, and skip the write — a body file no page can reach.
          const nextEntries = draft.isNew
            ? [...entries, compactionDraft
              // A new compaction record carries the switch a section would have,
              // switched off, because `enabled` decides nothing for it: the pointer
              // is what makes it live.
              ? { id: draft.id, title: draft.title, order: draft.order, enabled: false, kind: 'compaction' }
              : { id: draft.id, title: draft.title, order: draft.order, enabled: true }]
            : entries.map((entry) => entry.id === draft.id
              ? { ...entry, title: draft.title, order: draft.order }
              : entry)
          if (indexChanged(entries, nextEntries) && !await accepted(scope, 'entries', nextEntries)) {
            // Half a save is worth saying precisely: the prose is stored, only the
            // index write was refused, and pressing save again finishes it. The
            // draft keeps its unsaved side, so the editor stays dirty and the
            // retry appends the record the first attempt never wrote.
            setDraft(placed)
            setSaved(null)
            setStatus({ kind: 'error', text: refusalText('本文は保存されましたが、インデックスに書き込めませんでした') })
            await refreshStore()
            return
          }
          const next = { ...placed, isNew: false }
          setDraft(next)
          setSaved(next)
          // Saving a compaction instruction aims nothing. Which instruction a
          // conversation sends is that conversation's own choice, so this save
          // creates the entry and stops there: the composer's compaction chip is
          // the only place it can be put in force, and it is in force for the
          // conversations that pick it and for no others.
          setStatus({
            kind: 'info',
            text: compactionDraft
              ? '保存しました。特定のセッションで使うには、そのセッションの入力欄の「圧縮」チップで選んでください。'
              : '保存しました。次のモデルステップから有効になります。',
          })
          await refreshStore()
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [compactionDraft, draft, entries, refreshStore, scope])

      // ── presets ──────────────────────────────────────────────────────────────

      /**
       * Enter the preset editor: an existing one, or an empty draft.
       *
       * A new preset has no id yet, because the id has to be one no other preset
       * holds and only the Host knows that — so it is allocated on save, by the
       * same route the entry editor uses.
       * @param preset - the preset to edit, or `null` for a new one.
       */
      const openPreset = React.useCallback((preset) => {
        setPresetDraft(preset === null
          ? { id: null, name: '', members: [] }
          : {
            id: preset.id,
            name: preset.name,
            members: [...preset.entries],
          })
        setStatus(null)
        setView('preset')
      }, [])

      /** Leave the preset editor, keeping nothing unsaved. */
      const closePreset = React.useCallback(() => {
        setPresetDraft(null)
        setStatus(null)
        setView('presets')
      }, [])

      /**
       * Write the draft over the preset list.
       *
       * The list is one settings field and the Host replaces it whole, so this
       * is the complete next list rather than a patch — the same shape the entry
       * index is written in.
       */
      const savePreset = React.useCallback(async () => {
        if (presetDraft === null) return
        const label = presetDraft.name.trim()
        if (label.length === 0) {
          setStatus({ kind: 'error', text: 'プリセットに名前をつけてください。' })
          return
        }
        if (presetDraft.members.length === 0
          && !window.confirm('このプリセットにはプロンプトが1つも選ばれていません。有効にしても1つも注入されません。このまま保存しますか？')) return
        setBusy(true)
        try {
          const held = presetDraft.id
          const id = held !== null ? held : (await request('POST', '/preset/id', { title: label })).id
          // Only section membership belongs to a preset. The normalized records
          // also omit obsolete compression bindings from an older document.
          const next = held !== null
            ? presets.map((preset) => (preset.id === held
              ? { id, name: label, entries: presetDraft.members }
              : preset))
            : [...presets, {
              id,
              name: label,
              entries: presetDraft.members,
            }]
          if (presetsDiffer(presets, next) && !await accepted(scope, 'presets', next)) {
            // The list is one field, so a refusal is all-or-nothing: nothing of
            // this preset is stored, and the editor stays open on the draft.
            setStatus({ kind: 'error', text: refusalText('プリセットは保存されませんでした') })
            return
          }
          setPresetDraft({
            id,
            name: label,
            members: presetDraft.members,
          })
          setStatus({ kind: 'info', text: `プリセット「${label}」保存しました。` })
          setView('presets')
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [presetDraft, presets, scope])

      const removePreset = React.useCallback(async (preset) => {
        if (!window.confirm(`プリセット「${preset.name}」を削除しますか？`)) return
        setBusy(true)
        try {
          // One write. There is no selection to clear with it any more: no
          // conversation's choice lived in this document, so deleting the preset
          // some conversation happens to have chosen leaves that conversation
          // reading an id that names nothing — which is exactly how the Host
          // already treats a preset somebody deleted, and it says so in its log.
          if (!await accepted(scope, 'presets', presets.filter((candidate) => candidate.id !== preset.id))) {
            setStatus({ kind: 'error', text: refusalText('プリセットは削除されませんでした') })
            return
          }
          setStatus({ kind: 'info', text: `プリセット「${preset.name}」を削除しました。` })
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [presets, scope])

      // ── preset packs ─────────────────────────────────────────────────────────

      /**
       * Hand one preset to the browser as a file.
       *
       * The Host builds the pack, so the body it carries is the one this machine
       * would actually inject — not whatever the page last fetched. A failure is
       * shown rather than swallowed: a download that silently does nothing is
       * indistinguishable from a browser that ignored it.
       */
      const exportPreset = React.useCallback(async (preset) => {
        setBusy(true)
        setStatus(null)
        try {
          const response = await fetch(`${ROUTE}/pack/export?preset=${encodeURIComponent(preset.id)}`)
          const text = await response.text()
          if (!response.ok) {
            let detail = `エクスポート失敗（HTTP ${String(response.status)}）`
            try {
              const payload = JSON.parse(text)
              if (typeof payload.error === 'string') detail = payload.error
            } catch { /* not JSON: the status line stands */ }
            throw new Error(detail)
          }
          const name = `prompt-manager-pack-${preset.id}.json`
          saveFile(name, text)
          setStatus({ kind: 'info', text: `プリセット「${preset.name}」をエクスポートしました：${name}` })
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [])

      /**
       * Read one file back into this deployment.
       *
       * The page sends the text as it found it: validating a pack belongs where
       * the bodies are written, so a refusal names the entry that is wrong
       * instead of the first thing a browser-side check happened to notice.
       */
      const importPackFile = React.useCallback(async (file) => {
        if (file === undefined || file === null) return
        setBusy(true)
        setStatus(null)
        try {
          const text = await file.text()
          let payload
          try {
            payload = JSON.parse(text)
          } catch {
            throw new Error(`${file.name} は JSON ファイルではありません`)
          }
          const report = await request('POST', '/pack/import', payload)
          setStatus({ kind: 'info', text: describeImport(report) })
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [])

      /** What an import did, in one line, including everything it could not do. */
      function describeImport(report) {
        const entries = Array.isArray(report && report.entries) ? report.entries : []
        const preset = report && typeof report.preset === 'object' && report.preset !== null ? report.preset : { name: '?' }
        const parts = [`${String(entries.length)} 件インポートしました。プリセット「${String(preset.name)}」`]
        const renames = Array.isArray(report.renamed) ? report.renamed : []
        if (renames.length > 0) {
          const shown = renames.slice(0, 3).map((rename) => `${rename.from}→${rename.to}`).join('、')
          parts.push(`${String(renames.length)} 件の id が変わりました（${shown}${renames.length > 3 ? '…' : ''}）`)
        }
        const noBody = Array.isArray(report.noBody) ? report.noBody : []
        if (noBody.length > 0) parts.push(`${noBody.join('、')} の本文はサブスクライブソース由来です。「ソース」ページでそのリポジトリを設定すると取得できます`)
        const dropped = Array.isArray(report.sourceDropped) ? report.sourceDropped : []
        if (dropped.length > 0) parts.push(`${dropped.join('、')} の id はローカルで既に使われているため、通常エントリとしてインポートしました（アップストリームには追従しません）`)
        const missing = Array.isArray(report.missingMembers) ? report.missingMembers : []
        if (missing.length > 0) parts.push(`プリセットには ${missing.join('、')} が含まれていますが、ローカルにこれらのエントリはありません`)
        const unregistered = Array.isArray(report.unregistered) ? report.unregistered : []
        if (unregistered.length > 0) {
          parts.push(`${unregistered.map((name) => `{{${name}}}`).join(' ')} 現在の変数カタログに載っていません。セッションの組み立て時にいずれかのソースが提供しているか確認してください`)
        }
        return `${parts.join('；')}。インポートしてもこのプリセットは自動で有効になりません。`
      }

      /** Give a text file to the browser's downloader. */
      function saveFile(name, text) {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = name
        // Firefox only follows a click on an anchor that is in the document.
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        URL.revokeObjectURL(url)
      }

      // ── subscriptions ────────────────────────────────────────────────────────

      /** Add a source: the Host validates the three fields and allocates the slug. */
      const addSource = React.useCallback(async () => {
        const repo = newRepo.trim()
        if (repo.length === 0) {
          setStatus({ kind: 'error', text: '先に owner/name を入力してください。' })
          return
        }
        const ref = newRef.trim().length === 0 ? 'main' : newRef.trim()
        const mirror = newMirror.trim()
        setBusy(true)
        try {
          const allocated = await request('POST', '/sources', { repo, ref, mirror })
          // The Host echoes what it validated; prefer it, so the stored record is
          // exactly the one it accepted rather than this form's raw text.
          const next = [...configured, {
            id: allocated.id,
            repo: typeof allocated.repo === 'string' ? allocated.repo : repo,
            ref: typeof allocated.ref === 'string' ? allocated.ref : ref,
            mirror: typeof allocated.mirror === 'string' ? allocated.mirror : mirror,
            enabled: true,
          }]
          if (!await accepted(scope, 'sources', next)) {
            // The Host allocated a slug, but nothing recorded it: checking a source
            // no page and no engine can see would only produce a report about it.
            setStatus({ kind: 'error', text: refusalText('ソースは追加されませんでした') })
            return
          }
          setNewRepo('')
          setNewMirror('')
          setStatus({ kind: 'info', text: `ソース ${allocated.id} を追加しました。確認中…` })
          const outcome = await request('POST', `/sources/${encodeURIComponent(allocated.id)}/check`)
          setReport(outcome)
          setPicked(changedPaths(outcome))
          await refreshSources()
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [configured, newMirror, newRef, newRepo, refreshSources, scope])

      const checkSource = React.useCallback(async (slug) => {
        setBusy(true)
        try {
          const outcome = await request('POST', `/sources/${encodeURIComponent(slug)}/check`)
          const changes = Array.isArray(outcome.changes) ? outcome.changes : []
          setReport({ ...outcome, changes })
          setPicked(changedPaths(outcome))
          setStatus({
            kind: 'info',
            text: outcome.upToDate === true ? `「${slug}」は最新です。` : `「${slug}」には ${String(changes.length)} 個の更新可能なファイルがあります。`,
          })
          await refreshSources()
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [refreshSources])

      const applySource = React.useCallback(async (slug) => {
        setBusy(true)
        try {
          const outcome = await request('POST', `/sources/${encodeURIComponent(slug)}/apply`, { files: picked })
          setReport(null)
          setPicked([])
          const applied = Array.isArray(outcome.applied) ? outcome.applied : []
          setStatus({ kind: 'info', text: `「${slug}」は ${String(applied.length)} 個のファイルを適用しました。新規エントリはデフォルトで無効化されるため、有効化してから注入されます。` })
          await refreshSources()
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [picked, refreshSources])

      const revertSource = React.useCallback(async (slug) => {
        if (!window.confirm(`「${slug}」を前回の適用前の本文に復元しますか？`)) return
        setBusy(true)
        try {
          const outcome = await request('POST', `/sources/${encodeURIComponent(slug)}/revert`)
          const reverted = Array.isArray(outcome.reverted) ? outcome.reverted : []
          setStatus({ kind: 'info', text: `「${slug}」は ${String(reverted.length)} 個のファイルを復元しました。` })
          await refreshSources()
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [refreshSources])

      const removeSource = React.useCallback(async (slug) => {
        if (!window.confirm(`ソース「${slug}」を削除しますか？インポートされたエントリも一緒に削除されますが、ローカルエントリは影響を受けません。`)) return
        setBusy(true)
        try {
          // The Host drops the files and rebuilds the index; the settings writes
          // only record what it already did. Deleting first keeps a failure from
          // leaving the page showing a source the engine still has.
          const outcome = await request('DELETE', `/sources/${encodeURIComponent(slug)}`)
          if (!await accepted(scope, 'entries', Array.isArray(outcome.entries)
            ? outcome.entries
            : entries.filter((entry) => entry.source !== slug))) {
            setStatus({ kind: 'error', text: refusalText('ソースのファイルは削除されましたが、インデックスが更新されていません') })
            return
          }
          if (!await accepted(scope, 'sources', configured.filter((source) => source.id !== slug))) {
            setStatus({ kind: 'error', text: refusalText('インデックスは更新されましたが、ソース一覧が更新されていません') })
            return
          }
          if (report !== null && report.slug === slug) setReport(null)
          await refreshSources()
          setStatus({ kind: 'info', text: `已ソースを削除「${slug}」。` })
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [configured, entries, refreshSources, report, scope])

      /** Turn a subscribed entry into an editable local one, body and all. */
      const forkEntry = React.useCallback(async () => {
        if (draft === null) return
        setBusy(true)
        try {
          const allocated = await request('POST', '/id', { title: draft.title })
          const title = `${draft.title}（ローカル）`
          // The index goes first. If the body write then fails, what is left is a
          // visible entry with an empty body — which this editor can fix — where
          // the other order would leave a body file no page can reach.
          if (!await accepted(scope, 'entries', [...entries, { id: allocated.id, title, order: draft.order, enabled: false }])) {
            // The index goes first on purpose, so a refusal stops here: a copied
            // body for an entry no index carries is a file no page can reach.
            setStatus({ kind: 'error', text: refusalText('インデックスに書き込めず、fork が完了しませんでした') })
            return
          }
          const forked = {
            id: allocated.id,
            title,
            order: draft.order,
            body: draft.body,
            source: 'empty',
            fileSha1: null,
            isNew: false,
          }
          setSelectedId(allocated.id)
          setDraft(forked)
          setSaved(null)
          const written = await request('PUT', `/body/${encodeURIComponent(allocated.id)}`, { body: draft.body, fileSha1: null })
          // The body file exists now, so the editor must fence against exactly
          // what the write produced: keeping `null` would make the next save look
          // like a create, and the store refuses to create over an existing file.
          const placed = {
            ...forked,
            source: typeof written.source === 'string' ? written.source : 'user',
            fileSha1: typeof written.fileSha1 === 'string' ? written.fileSha1 : null,
          }
          setDraft(placed)
          setSaved(placed)
          setStatus({ kind: 'info', text: `${allocated.id} として fork しました。編集して保存してください。元のサブスクライブエントリは引き続き更新に追従します。` })
          await refreshStore()
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [draft, entries, refreshStore, scope])

      const toggle = React.useCallback(async (entry, enabled) => {
        const nextEntries = entries.map((candidate) => candidate.id === entry.id ? { ...candidate, enabled } : candidate)
        setBusy(true)
        try {
          if (!await accepted(scope, 'entries', nextEntries)) {
            setStatus({ kind: 'error', text: refusalText('インデックスに書き込めませんでした') })
            return
          }
          setStatus({ kind: 'info', text: enabled ? `「${entry.title}」を有効にしました。` : `「${entry.title}」を無効にしました。` })
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [entries, scope])

      const remove = React.useCallback((entry) => {
        if (!window.confirm(`「${entry.title}」を削除しますか？本文ファイルも一緒に削除されます。`)) return
        setBusy(true)
        // The body file goes first: if that fails, nothing has changed and the
        // entry is still there to retry, rather than an index record pointing at
        // a file the page no longer shows.
        request('DELETE', `/body/${encodeURIComponent(entry.id)}`)
          .then(async () => {
            if (!await accepted(scope, 'entries', entries.filter((candidate) => candidate.id !== entry.id))) {
              setStatus({ kind: 'error', text: refusalText('本文ファイルは削除されましたが、インデックスが更新されていません') })
              return
            }
            // Nothing else to release: a conversation that had chosen this entry
            // keeps the id in its own file and reads it as naming nothing, which is
            // what the Host does with any id an index no longer carries.
            if (selectedId === entry.id) {
              setDraft(null)
              setSaved(null)
              setSelectedId(null)
            }
            await refreshStore()
            setStatus({ kind: 'info', text: `「${entry.title}」を削除しました。` })
          })
          .catch((error) => setStatus({ kind: 'error', text: failureText(error) }))
          .finally(() => setBusy(false))
      }, [entries, refreshStore, scope, selectedId])

      // ── variables and scripts ────────────────────────────────────────────────

      /** Copy one `{{name}}` so it can be pasted into a body. */
      const copyVariable = React.useCallback((name) => {
        const token = `{{${name}}}`
        const clipboard = typeof navigator === 'object' && navigator !== null ? navigator.clipboard : undefined
        if (clipboard !== undefined && clipboard !== null && typeof clipboard.writeText === 'function') {
          clipboard.writeText(token)
            .then(() => { setStatus({ kind: 'info', text: `コピーしました ${token}` }) })
            .catch((error) => { setStatus({ kind: 'info', text: token }) })
          return
        }
        setStatus({ kind: 'info', text: token })
      }, [])

      /**
       * Put one `{{name}}` into the body being edited, at the caret.
       *
       * Only the editor calls this: it is the one place where the body it edits
       * is on screen, and where a reference that lands somewhere unexpected is
       * something you can see and undo.
       * @param name - the variable to reference.
       */
      const insertVariable = React.useCallback((name) => {
        if (draft === null) return
        const token = `{{${name}}}`
        const at = typeof caret === 'number' && caret >= 0 && caret <= draft.body.length ? caret : draft.body.length
        setDraft({ ...draft, body: `${draft.body.slice(0, at)}${token}${draft.body.slice(at)}` })
        setCaret(at + token.length)
      }, [caret, draft])

      /** Open a script in the editor: an existing one, or a fresh template. */
      const openScript = React.useCallback(async (name) => {
        setBusy(true)
        setRunReport(null)
        try {
          if (name === null) {
            const fresh = { name: '', source: SCRIPT_TEMPLATE, fileSha1: null, isNew: true }
            setScriptDraft(fresh)
            setScriptSaved(fresh)
          } else {
            const stored = await request('GET', `/script/${encodeURIComponent(name)}`)
            const opened = {
              name,
              source: typeof stored.source === 'string' ? stored.source : '',
              fileSha1: typeof stored.sha1 === 'string' ? stored.sha1 : null,
              isNew: false,
            }
            setScriptDraft(opened)
            setScriptSaved(opened)
          }
          setStatus(null)
          setView('script')
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [])

      /**
       * Run what the editor holds, without saving it.
       *
       * Always sent as a source, so the Host writes a throwaway copy, runs that,
       * and registers nothing — the same code, the same command and the same
       * directory a save would use, minus the side effects. Running the saved
       * file itself is the variables page's own 「1回実行」, which is also what
       * refreshes the values in force.
       */
      const testScript = React.useCallback(async () => {
        if (scriptDraft === null) return
        setBusy(true)
        try {
          const name = scriptDraft.name.trim()
          const report = await request('POST', '/variables/run', {
            name: name.length > 0 ? name : 'draft',
            source: scriptDraft.source,
          })
          setRunReport(report)
          setStatus(report.ok === true
            ? { kind: 'info', text: `今回の実行で ${String(Object.keys(report.variables ?? {}).length)} 個の変数が提供されました。保存後に登録されます。` }
            : { kind: 'error', text: report.problems.join('；') })
        } catch (error) {
          setRunReport(error.report === undefined ? null : error.report)
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [scriptDraft])

      /** Save a script: the Host validates, runs, and only then writes it. */
      const saveScript = React.useCallback(async () => {
        if (scriptDraft === null) return
        const name = scriptDraft.name.trim()
        if (name.length === 0) {
          setStatus({ kind: 'error', text: 'スクリプトに名前をつけてください（英数字とハイフン。ファイル名になります）。' })
          return
        }
        setBusy(true)
        try {
          const saved = await request('PUT', `/script/${encodeURIComponent(name)}`, {
            source: scriptDraft.source,
            fileSha1: scriptDraft.fileSha1,
          })
          const written = { ...scriptDraft, name, fileSha1: typeof saved.sha1 === 'string' ? saved.sha1 : null, isNew: false }
          setScriptDraft(written)
          setScriptSaved(written)
          setRunReport(saved.report === undefined ? null : saved.report)
          await refreshVariables()
          const supplied = Object.keys(saved.variables ?? {})
          setStatus({
            kind: 'info',
            text: supplied.length === 0
              ? '保存しました。このスクリプトは変数を提供していません。'
              : `保存しましたして有効化：${supplied.map((variable) => `{{${variable}}}`).join(' ')}、次のモデルステップから有効になります。`,
          })
        } catch (error) {
          setRunReport(error.report === undefined ? null : error.report)
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [refreshVariables, scriptDraft])

      /** Measure every script again, and republish what they supply. */
      const refreshScripts = React.useCallback(async () => {
        setBusy(true)
        try {
          const outcome = await request('POST', '/variables/refresh')
          await refreshVariables()
          const reports = Array.isArray(outcome.reports) ? outcome.reports : []
          const failed = reports.filter((report) => report.ok !== true)
          setStatus(failed.length === 0
            ? { kind: 'info', text: `${String(reports.length)} 件のスクリプトを再測定しました。` }
            : {
              kind: 'error',
              text: `${String(failed.length)} 件のスクリプトが失敗しました：${failed.map((report) => `${report.name}（${report.problems.join('、')}）`).join('；')}`,
            })
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [refreshVariables])

      /**
       * Forget a script.
       *
       * The values it declared stay in force — a reference with no value fails
       * assembly — so the confirmation names the entries that would be left
       * holding the last measured value.
       */
      const removeScript = React.useCallback(async (name) => {
        const affected = variables.filter((variable) => variable.detail === name && variable.referencedBy.length > 0)
        const question = affected.length === 0
          ? `スクリプト「${name}」を削除しますか？ファイルも削除されます。`
          : `スクリプト「${name}」を削除しますか？これらの変数はまだプロンプトに参照されています：${affected.map((variable) => `${variable.name}（${variable.referencedBy.join('、')}）`).join('；')}。削除後も最後に測定した値が使われ、プロファイルを再起動した後に完全に消去されます。`
        if (!window.confirm(question)) return
        setBusy(true)
        try {
          await request('DELETE', `/script/${encodeURIComponent(name)}`)
          await refreshVariables()
          if (scriptDraft !== null && scriptDraft.name === name) {
            setScriptDraft(null)
            setScriptSaved(null)
            setView('variables')
          }
          setStatus({ kind: 'info', text: `スクリプト「${name}」を削除しました。提供していた変数は最後の値のまま残ります。` })
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [refreshVariables, scriptDraft, variables])

      /**
       * Run a saved script from the list, without opening the editor.
       *
       * The list has nowhere to show a full run report, so the outcome is
       * summarised here and the editor stays the place that shows the variables,
       * the exit code, and stderr in full.
       */
      const runScript = React.useCallback(async (name) => {
        setBusy(true)
        try {
          const report = await request('POST', '/variables/run', { name })
          await refreshVariables()
          const provided = Object.keys(report.variables ?? {}).length
          setStatus(report.ok === true
            ? {
              kind: 'info',
              text: `「${name}」は ${String(provided)} 個の変数を提供しました${report.exitCode === undefined ? '' : `（退出码 ${String(report.exitCode)}）`}、所要時間 ${String(report.ms)}ms。`,
            }
            : { kind: 'error', text: report.problems.join('；') })
        } catch (error) {
          setStatus({ kind: 'error', text: failureText(error) })
        } finally {
          setBusy(false)
        }
      }, [refreshVariables])

      const statusLine = status === null ? null : h('p', {
        key: 'status',
        className: status.kind === 'error' ? 'dsh-prompt-manager__status dsh-prompt-manager__status--error' : 'dsh-prompt-manager__status',
        role: status.kind === 'error' ? 'alert' : 'status',
      }, status.text)

      // ── the editor page ─────────────────────────────────────────────────────

      if (view === 'editor' && draft !== null) {
        return h('div', { className: 'dsh-prompt-manager' }, [
          h('div', { key: 'head', className: 'dsh-prompt-manager__head' }, [
            h(Button, { key: 'back', variant: 'ghost', disabled: busy, onClick: back }, '← 戻る'),
            h('h2', { key: 'title', className: 'dsh-prompt-manager__headTitle' }, `「${draft.title}」を編集`),
            h('span', { key: 'spacer', className: 'dsh-prompt-manager__headSpacer' }),
            h('span', { key: 'id', className: 'dsh-prompt-manager__note' }, [
              `id ${draft.id}`,
              draft.isNew ? '（未保存）' : '',
              subscribedDraft
                ? ' · サブスクライブ本文（読み取り専用）'
                : builtinDraft
                  ? ' · プラグイン内蔵本文（保存で上書き）'
                  : (draft.fileSha1 === null ? ' · 本文ファイルがまだありません' : ' · 保存済み'),
            ].join('')),
          ]),
          compactionDraft
            ? h('p', { key: 'role', className: 'dsh-prompt-manager__note' },
              'これは system prompt セクションではなく、圧縮時に DSH 内蔵の命令を置き換えるテキストです。保存すると次回の圧縮から有効になります（次のモデルステップではありません）。本文には {{変数}} を使えます。')
            : null,
          h('div', { key: 'form', className: 'dsh-prompt-manager__surface' }, [
            h('div', { key: 'fields', className: 'dsh-prompt-manager__fields' }, [
              h('label', { key: 'title', className: 'dsh-prompt-manager__field dsh-prompt-manager__field--grow' }, [
                'タイトル',
                h('input', {
                  key: 'input',
                  value: draft.title,
                  disabled: !writable || busy,
                  onChange: (event) => setDraft({ ...draft, title: event.target.value }),
                }),
              ]),
              h('label', { key: 'order', className: 'dsh-prompt-manager__field dsh-prompt-manager__field--order' }, [
                '順序',
                h('input', {
                  key: 'input',
                  type: 'number',
                  value: String(draft.order),
                  disabled: !writable || busy,
                  onChange: (event) => {
                    // An empty box or a lone `-` parses to something unusable;
                    // keeping the previous number is kinder than writing a value
                    // the index schema then refuses.
                    const parsed = Number(event.target.value)
                    if (!Number.isFinite(parsed)) return
                    setDraft({ ...draft, order: parsed })
                  },
                }),
              ]),
            ]),
          h('div', { key: 'body', className: 'dsh-prompt-manager__pane' }, [
            h('span', { key: 'label', className: 'dsh-prompt-manager__paneLabel' }, subscribedDraft
              ? 'Markdown 本文（サブスクライブ元・読み取り専用）'
              : builtinDraft ? 'Markdown 本文（プラグイン内蔵・保存で上書き）' : 'Markdown 本文'),
            h('textarea', {
              key: 'textarea',
              value: draft.body,
              disabled: !writable || busy,
              readOnly: subscribedDraft,
              spellCheck: false,
              onChange: (event) => setDraft({ ...draft, body: event.target.value }),
              // The caret is where an inserted reference lands; a host that does
              // not report one simply gets the reference appended.
              onSelect: (event) => setCaret(event.target.selectionStart),
              onKeyUp: (event) => setCaret(event.target.selectionStart),
              onClick: (event) => setCaret(event.target.selectionStart),
            }),
          ]),
          h('div', { key: 'vars', className: 'dsh-prompt-manager__actions' }, [
            h('span', { key: 'label', className: 'dsh-prompt-manager__note' }, '使える変数（クリックでカーソル位置に挿入）：'),
            ...knownVariables.map((name) => h(Button, {
              key: name,
              disabled: busy || !writable,
              onClick: () => insertVariable(name),
            }, `{{${name}}}`)),
          ]),
          variables.some((variable) => variable.source === 'dsh')
            ? h('p', { key: 'native-vars', className: 'dsh-prompt-manager__note' },
              'DSH ネイティブ変数は現在の agent / セッション単位で動的に解決され、スクリプトの登録は不要です。ここのプレビューは Markdown のレンダリングのみで、特定セッションのディレクトリやモデルは反映しません。')
            : null,
          unknownInDraft.length === 0 ? null : h('span', {
            key: 'unknown',
            className: 'dsh-prompt-manager__status dsh-prompt-manager__status--error',
          }, `これらの参照は現在の変数カタログに載っていません：${unknownInDraft.map((name) => `{{${name}}}`).join(' ')}（他のプラグインから提供されている可能性があります。セッションの組み立て時に解決できなければ、ホストがリテラルとして保持し、警告を記録します）`),
          malformedInDraft.length === 0 ? null : h('span', {
            key: 'malformed',
            className: 'dsh-prompt-manager__status dsh-prompt-manager__status--error',
          }, `これらの参照の書き方が正しくありません：${malformedInDraft.map((name) => `{{${name}}}`).join(' ')}（レジストリはこの書き方を解析できず、ホストはリテラルとしてレンダリングします。また保存は拒否されます。変数名は数字・アンダースコア・小文字アルファベットのみで、先頭はアルファベットでなければなりません）`),
          h('div', { key: 'preview', className: 'dsh-prompt-manager__pane' }, [
            h('span', { key: 'label', className: 'dsh-prompt-manager__paneLabel' }, 'プレビュー'),
            h('div', { key: 'body', className: 'dsh-prompt-manager__preview' }, h(Preview, { text: draft.body })),
          ]),
          ]),
          h('div', { key: 'actions', className: 'dsh-prompt-manager__actions' }, [
            h(Button, { key: 'save', variant: 'primary', disabled: !writable || busy || !dirty, onClick: save }, dirty ? '変更を保存' : '保存しました'),
            // Neither "set as current" nor "change what this entry is" is offered here:
            // which instruction a compaction sends is the conversation's own choice, and
            // what an entry is was settled when it was created.
            subscribedDraft
              ? h(Button, { key: 'fork', disabled: !writable || busy, onClick: () => { void forkEntry() } }, 'ローカルエントリに fork')
              : null,
            compactionDraft
              ? h('span', { key: 'note', className: 'dsh-prompt-manager__note' },
                'これはセッションごとの選択項目です。使いたいセッションの入力欄にある「圧縮」チップで選んでください。このページはどのセッションの選択も変更しません。')
              : null,
            subscribedDraft
              ? h('span', { key: 'note', className: 'dsh-prompt-manager__note' }, 'サブスクライブエントリの本文はアップストリームから取得するため、「更新を確認」からしか変更できません。自分で編集するには先に fork してください。')
              : builtinDraft
                ? h('span', { key: 'note', className: 'dsh-prompt-manager__note' }, 'この本文はプラグイン内蔵のデフォルトです。保存するとローカルの上書き版として書き込まれ、プラグインをアップグレードしても上書きされません。')
                : null,
          ]),
          statusLine,
        ])
      }

      // ── the script editor ───────────────────────────────────────────────────

      if (view === 'script' && scriptDraft !== null) {
        const syntax = syntaxProblem(scriptDraft.source)
        return h('div', { className: 'dsh-prompt-manager' }, [
          h('div', { key: 'head', className: 'dsh-prompt-manager__head' }, [
            h(Button, {
              key: 'back',
              variant: 'ghost',
              disabled: busy,
              onClick: () => {
                // Leaving drops the draft, so an edited one is confirmed first —
                // a half-written script is not recoverable from anywhere else.
                const dirtyScript = scriptDraft !== null
                  && (scriptSaved === null || scriptDraft.source !== scriptSaved.source || scriptDraft.name !== scriptSaved.name)
                if (dirtyScript && !window.confirm(scriptDraft.isNew ? 'この新規スクリプトを破棄しますか？' : '未保存の変更を破棄しますか？')) return
                setScriptDraft(null)
                setScriptSaved(null)
                setRunReport(null)
                setView('variables')
              },
            }, '← 戻る'),
            h('h2', { key: 'title', className: 'dsh-prompt-manager__headTitle' },
              scriptDraft.isNew ? '新規スクリプト' : `スクリプト「${scriptDraft.name}」`),
            h('span', { key: 'spacer', className: 'dsh-prompt-manager__headSpacer' }),
            h('span', { key: 'state', className: 'dsh-prompt-manager__note' },
              scriptDraft.fileSha1 === null ? '未保存' : '保存しました'),
          ]),
          h('div', { key: 'form', className: 'dsh-prompt-manager__surface' }, [
            // `--grow` fills the width of a `__fields` row. Put straight into the
            // column `__surface` it fills the *height* instead, which is the blank
            // gap that used to sit under this input.
            h('div', { key: 'fields', className: 'dsh-prompt-manager__fields' }, [
              h('label', { key: 'name', className: 'dsh-prompt-manager__field dsh-prompt-manager__field--grow' }, [
                'スクリプト名（小文字アルファベット・数字・ハイフン。ファイル名になります）',
                h('input', {
                  key: 'input',
                  value: scriptDraft.name,
                  placeholder: 'toolchain',
                  disabled: !writable || busy || !scriptDraft.isNew,
                  onChange: (event) => setScriptDraft({ ...scriptDraft, name: event.target.value }),
                }),
              ]),
            ]),
            h('div', { key: 'body', className: 'dsh-prompt-manager__pane' }, [
              h('span', { key: 'label', className: 'dsh-prompt-manager__paneLabel' },
                'スクリプト本文：JSON オブジェクトを出力してください。キーがプロンプトで使える変数名です'),
              h('textarea', {
                key: 'textarea',
                value: scriptDraft.source,
                disabled: !writable || busy,
                spellCheck: false,
                onChange: (event) => setScriptDraft({ ...scriptDraft, source: event.target.value }),
              }),
            ]),
            syntax === null ? null : h('span', {
              key: 'syntax',
              className: 'dsh-prompt-manager__status dsh-prompt-manager__status--error',
            }, `構文エラー：${syntax}`),
            h('div', { key: 'actions', className: 'dsh-prompt-manager__actions' }, [
              h(Button, { key: 'run', disabled: !writable || busy || syntax !== null, onClick: () => { void testScript() } }, '1回実行（テスト）'),
              h(Button, {
                key: 'save',
                variant: 'primary',
                disabled: !writable || busy || syntax !== null,
                onClick: () => { void saveScript() },
              }, '保存して有効化'),
              scriptDraft.isNew
                ? null
                : h(Button, { key: 'remove', variant: 'danger', disabled: busy, onClick: () => { void removeScript(scriptDraft.name) } }, 'スクリプトを削除'),
            ]),
            h('span', { key: 'hint', className: 'dsh-prompt-manager__note' },
              '「1回実行」は上の入力欄の内容を実行します。同じコマンド・同じディレクトリですが、一時ファイルに書き出して実行後に削除するため、正式ファイルへの書き込みも変数の登録も行わません。そのため試しに実行しても現在の有効値は変更されません。保存時にもまず1回実行され、使える出力がなければディスクに書き込まれません。保存済みのファイル自体を検証するには、変数ページの「1回実行」を使ってください。'),
          ]),
          h(RunReport, { key: 'report', report: runReport }),
          statusLine,
        ])
      }

      // ── the sources page ────────────────────────────────────────────────────

      if (view === 'sources') {
        const cards = sources.map((source) => {
          const active = report !== null && report.slug === source.id
          const state = active && report.changes.length > 0
            ? 'pending'
            : active && report.warnings.length > 0 ? 'error' : 'ready'
          return h('div', { key: source.id, className: 'dsh-prompt-manager__source' }, [
            h('div', { key: 'head', className: 'dsh-prompt-manager__sourceHead' }, [
              h('span', {
                key: 'dot',
                className: state === 'ready'
                  ? 'dsh-prompt-manager__dot'
                  : `dsh-prompt-manager__dot dsh-prompt-manager__dot--${state}`,
                'aria-hidden': 'true',
              }),
              h('span', { key: 'repo', className: 'dsh-prompt-manager__sourceRepo' }, `${source.repo}@${source.ref}`),
              source.enabled === false
                ? h('span', { key: 'off', className: 'dsh-prompt-manager__badge' }, '無効')
                : null,
              h('span', { key: 'meta', className: 'dsh-prompt-manager__meta' }, [
                `${String(source.files)} 個のファイル`,
                source.appliedAt !== undefined ? `前回適用 ${stamp(source.appliedAt)}` : '未適用',
              ].join(' · ')),
            ]),
            // The note and the controls share one row. They used to be rows of their own
            // in the column under the head, and the head — identity, stats and all three
            // buttons in one wrapping row — did not fit a 555px panel: the buttons broke
            // onto a line of their own and the note was left alone on a third.
            h('div', { key: 'foot', className: 'dsh-prompt-manager__sourceFoot' }, [
              h('span', { key: 'note', className: 'dsh-prompt-manager__note' }, [
                source.headSha !== undefined ? `リモート ${source.headSha.slice(0, 7)}` : '未チェック',
                source.mirror.length > 0 ? `経由 ${source.mirror}` : '直接',
              ].join(' · ')),
              h('span', { key: 'spacer', className: 'dsh-prompt-manager__headSpacer' }),
              h('div', { key: 'actions', className: 'dsh-prompt-manager__sourceActions' }, [
                h(Button, { key: 'check', disabled: busy, onClick: () => { void checkSource(source.id) } }, '更新を確認'),
                h(Button, { key: 'revert', disabled: busy, onClick: () => { void revertSource(source.id) } }, '復元'),
                h(Button, { key: 'remove', variant: 'danger', disabled: busy, onClick: () => { void removeSource(source.id) } }, 'ソースを削除'),
              ]),
            ]),
            active && report.changes.length > 0
              ? h('div', { key: 'changes', className: 'dsh-prompt-manager__changes' }, [
                ...report.changes.map((change) => h('label', { key: change.path, className: 'dsh-prompt-manager__change' }, [
                  h('input', {
                    key: 'pick',
                    type: 'checkbox',
                    checked: picked.includes(change.path),
                    onChange: () => setPicked(picked.includes(change.path)
                      ? picked.filter((candidate) => candidate !== change.path)
                      : [...picked, change.path]),
                  }),
                  h('span', { key: 'path', className: 'dsh-prompt-manager__changePath' },
                    `${change.kind === 'removed' ? '（削除）' : ''}${change.path}`),
                  // A rename is one move across two rows. Saying so is what keeps
                  // it from looking like a deletion plus an unrelated new prompt —
                  // and it is why picking either row applies both.
                  change.renamedFrom === undefined && change.renamedTo === undefined
                    ? null
                    : h('span', { key: 'rename', className: 'dsh-prompt-manager__note' },
                      change.renamedFrom !== undefined ? `${change.renamedFrom} から改名` : `${change.renamedTo} に改名`),
                  h('span', { key: 'delta', className: 'dsh-prompt-manager__delta' }, `+${String(change.added)} / −${String(change.removed)}`),
                ])),
                h('div', { key: 'apply', className: 'dsh-prompt-manager__actions' }, [
                  h(Button, {
                    key: 'go',
                    variant: 'primary',
                    disabled: busy || picked.length === 0,
                    onClick: () => { void applySource(source.id) },
                  }, `適用（${String(picked.length)}）`),
                ]),
              ])
              : active
                ? h('span', { key: 'clean', className: 'dsh-prompt-manager__status dsh-prompt-manager__status--ok' }, '更新内容はありません。')
                : null,
            active && report.warnings.length > 0
              ? h('span', { key: 'warn', className: 'dsh-prompt-manager__status dsh-prompt-manager__status--error' }, report.warnings.join('；'))
              : null,
          ])
        })

        return h('div', { className: 'dsh-prompt-manager' }, [
          h('div', { key: 'head', className: 'dsh-prompt-manager__head' }, [
            h(Button, { key: 'back', variant: 'ghost', disabled: busy, onClick: () => { setView('list'); setReport(null) } }, '← 戻る'),
            h('h2', { key: 'title', className: 'dsh-prompt-manager__headTitle' }, 'サブスクライブソース'),
          ]),
          h('p', { key: 'lede', className: 'dsh-prompt-manager__intro' },
            'ソース = GitHub リポジトリ + ref です。リポジトリのルートに prompt-manager.json マニフェストが必要です。「更新を確認」はリモートの内容をステージング領域に取得するだけで、「適用」を押したときにローカルを上書きします。変更は次のモデルステップから有効になります。'),
          h('div', { key: 'add', className: 'dsh-prompt-manager__surface' }, [
            h('div', { key: 'fields', className: 'dsh-prompt-manager__fields' }, [
              h('label', { key: 'repo', className: 'dsh-prompt-manager__field dsh-prompt-manager__field--grow' }, [
                'リポジトリ（owner/name）',
                h('input', {
                  key: 'input',
                  value: newRepo,
                  placeholder: 'owner/repo',
                  disabled: busy,
                  onChange: (event) => setNewRepo(event.target.value),
                }),
              ]),
              h('label', { key: 'ref', className: 'dsh-prompt-manager__field dsh-prompt-manager__field--order' }, [
                'ref',
                h('input', {
                  key: 'input',
                  value: newRef,
                  disabled: busy,
                  onChange: (event) => setNewRef(event.target.value),
                }),
              ]),
              h('label', { key: 'mirror', className: 'dsh-prompt-manager__field dsh-prompt-manager__field--grow' }, [
                'ミラー（空欄可）',
                h('input', {
                  key: 'input',
                  value: newMirror,
                  placeholder: 'https://gh-proxy.example',
                  disabled: busy,
                  onChange: (event) => setNewMirror(event.target.value),
                }),
              ]),
            ]),
            h('div', { key: 'actions', className: 'dsh-prompt-manager__actions' }, [
              h(Button, { key: 'go', variant: 'primary', disabled: !writable || busy, onClick: () => { void addSource() } }, 'ソースを追加'),
            ]),
          ]),
          sources.length === 0
            ? h('div', { key: 'empty', className: 'dsh-prompt-manager__empty' }, 'サブスクライブソースがありません。')
            : h('div', { key: 'cards', className: 'dsh-prompt-manager__list' }, cards),
          statusLine,
        ])
      }

      // ── the variables page ──────────────────────────────────────────────────

      if (view === 'variables') {
        const variableRows = variables.map((variable) => h('div', {
          key: variable.name,
          className: 'dsh-prompt-manager__card',
        }, [
          h('div', { key: 'main', className: 'dsh-prompt-manager__cardMain', style: { cursor: 'default' } }, [
            h('span', { key: 'name', className: 'dsh-prompt-manager__title' }, `{{${variable.name}}}`),
            h('span', { key: 'value', className: 'dsh-prompt-manager__meta' },
              variable.source === 'dsh' ? '現在の agent / セッションで動的に解決' : variable.value),
            h('span', { key: 'refs', className: 'dsh-prompt-manager__meta' },
              variable.referencedBy.length === 0
                ? '参照しているプロンプトはまだありません'
                : `参照元：${variable.referencedBy.join('、')}`),
          ]),
          h('div', { key: 'side', className: 'dsh-prompt-manager__cardSide' }, [
            h('span', { key: 'source', className: 'dsh-prompt-manager__badge' },
              SOURCE_LABELS[variable.source] === undefined ? variable.source : SOURCE_LABELS[variable.source]),
            variable.detail === undefined
              ? null
              : h('span', { key: 'detail', className: 'dsh-prompt-manager__meta' }, variable.detail),
            h(Button, { key: 'copy', disabled: busy, onClick: () => copyVariable(variable.name) }, '参照をコピー'),
          ]),
        ]))

        const scriptCards = scripts.map((script) => h('div', {
          key: script.name,
          className: 'dsh-prompt-manager__source',
        }, [
          h('div', { key: 'head', className: 'dsh-prompt-manager__sourceHead' }, [
            h('span', {
              key: 'dot',
              className: script.error === undefined
                ? 'dsh-prompt-manager__dot'
                : 'dsh-prompt-manager__dot dsh-prompt-manager__dot--error',
              'aria-hidden': 'true',
            }),
            h('span', { key: 'name', className: 'dsh-prompt-manager__sourceRepo' }, script.name),
            h('span', { key: 'meta', className: 'dsh-prompt-manager__meta' }, [
              script.variables.length === 0 ? '変数はまだありません' : script.variables.map((name) => `{{${name}}}`).join(' '),
              script.ranAt === undefined ? '実行成功なし' : `前回実行 ${stamp(script.ranAt)}`,
              script.pending === true ? 'ファイルが変更されたため再テストが必要' : '',
            ].filter((part) => part.length > 0).join(' · ')),
            h('span', { key: 'spacer', className: 'dsh-prompt-manager__headSpacer' }),
            h('div', { key: 'actions', className: 'dsh-prompt-manager__sourceActions' }, [
              h(Button, { key: 'run', disabled: busy, onClick: () => { void runScript(script.name) } }, '1回実行'),
              h(Button, { key: 'edit', disabled: busy, onClick: () => { void openScript(script.name) } }, '編集'),
              h(Button, { key: 'remove', variant: 'danger', disabled: busy, onClick: () => { void removeScript(script.name) } }, '削除'),
            ]),
          ]),
          script.error === undefined
            ? null
            : h('span', { key: 'error', className: 'dsh-prompt-manager__status dsh-prompt-manager__status--error' }, script.error),
        ]))

        return h('div', { className: 'dsh-prompt-manager' }, [
          h('div', { key: 'head', className: 'dsh-prompt-manager__head' }, [
            h(Button, {
              key: 'back',
              variant: 'ghost',
              disabled: busy,
              // Through the same guard the editor uses: a body edited from this
              // page (an inserted reference) must not vanish without a word.
              onClick: () => { back(); setRunReport(null) },
            }, '← 戻る'),
            h('h2', { key: 'title', className: 'dsh-prompt-manager__headTitle' }, 'プロンプト変数'),
            h('span', { key: 'spacer', className: 'dsh-prompt-manager__headSpacer' }),
            h(Button, { key: 'refresh', disabled: busy, onClick: () => { void refreshScripts() } }, '再測定'),
          ]),
          h('p', { key: 'lede', className: 'dsh-prompt-manager__intro' },
            '変数は、プロンプト内の中括弧参照の参照元です。システム情報はプラグインが登録し、DSH ネイティブ変数は現在の agent / セッション単位で動的に解決され、スクリプトはあなたが書きます。ネイティブ変数には用途のみが表示され、特定セッションの実際の値は表示されません。スクリプトは1つにつき1つの JSON を出力し、そのキーが変数名になります。独立した子プロセスで動くため、タイムアウトやエラーが発生しても DSH 本体に影響は及びません。'),
          variableReport !== null && typeof variableReport.error === 'string'
            ? h('p', { key: 'error', className: 'dsh-prompt-manager__status dsh-prompt-manager__status--error' }, variableReport.error)
            : null,
          variableRows.length === 0
            ? h('div', { key: 'empty', className: 'dsh-prompt-manager__empty' }, '登録されている変数はありません。')
            : h('div', { key: 'vars', className: 'dsh-prompt-manager__list' }, variableRows),
          h('div', { key: 'scripts', className: 'dsh-prompt-manager__block' }, [
            h('span', { key: 'label', className: 'dsh-prompt-manager__paneLabel' }, `スクリプト（${String(scripts.length)}）`),
            scripts.length === 0
              ? h('div', { key: 'none', className: 'dsh-prompt-manager__empty' }, 'スクリプトがありません。「新規スクリプト」を押すと、そのまま実行できるテンプレートが作られます。')
              : h('div', { key: 'cards', className: 'dsh-prompt-manager__list' }, scriptCards),
            h('div', { key: 'addRow', className: 'dsh-prompt-manager__addRow' }, [
              h(AddButton, { key: 'add', disabled: !writable || busy, onClick: () => { void openScript(null) } }, '新規スクリプト'),
            ]),
          ]),
          statusLine,
        ])
      }

      // ── the presets page ────────────────────────────────────────────────────

      /**
       * The title one entry id stands for.
       *
       * A preset may name an entry the index does not carry — a subscription that
       * has not come back, or a body somebody removed by hand — and saying so is
       * better than showing a bare id nobody can act on.
       * @param id - the entry id a preset selected.
       * @returns the entry's title, or a marker naming the missing id.
       */
      const titleOfEntry = (id) => {
        const known = entries.find((entry) => entry.id === id)
        return known !== undefined ? known.title : `（エントリが存在しません：${id}）`
      }

      /**
       * The preset editor: a name, and the entries this preset selects.
       *
       * The checklist is the whole entry index rather than only the ones switched
       * on, because a preset is what decides injection — an entry a person left
       * off is exactly the kind of thing a preset exists to turn on.
       */
      if (view === 'preset' && presetDraft !== null) {
        const members = presetDraft.members
        // Presets select ordinary sections only. Compression is chosen manually
        // in the session's separate control, never in this editor.
        const selectable = entries.filter((entry) => !isCompaction(entry))
        const missing = members.filter((id) => !entries.some((entry) => entry.id === id))
        const rows = selectable.map((entry) => {
          const checked = members.includes(entry.id)
          return h('label', { key: entry.id, className: 'dsh-prompt-manager__member' }, [
            h('input', {
              key: 'pick',
              type: 'checkbox',
              checked,
              disabled: busy,
              onChange: () => setPresetDraft({
                ...presetDraft,
                members: checked
                  ? members.filter((id) => id !== entry.id)
                  : [...members, entry.id],
              }),
            }),
            h('span', { key: 'title', className: 'dsh-prompt-manager__memberLabel' }, entry.title),
            h('span', { key: 'id', className: 'dsh-prompt-manager__memberId' }, entry.id),
            h('span', { key: 'state', className: 'dsh-prompt-manager__note' },
              entry.enabled === true ? 'トグル：オン' : 'トグル：オフ'),
          ])
        })

        return h('div', { className: 'dsh-prompt-manager' }, [
          h('div', { key: 'head', className: 'dsh-prompt-manager__head' }, [
            h(Button, { key: 'back', variant: 'ghost', disabled: busy, onClick: closePreset }, '← 戻る'),
            h('h2', { key: 'title', className: 'dsh-prompt-manager__headTitle' },
              presetDraft.id === null ? '新規プリセット' : `プリセット：${presetDraft.name}`),
            presetDraft.id === null
              ? null
              : h('span', { key: 'id', className: 'dsh-prompt-manager__badge' }, presetDraft.id),
          ]),
          h('p', { key: 'lede', className: 'dsh-prompt-manager__intro' },
            'このプリセットが注入する通常プロンプトにチェックを入れてください。プリセットを有効にすると、どのエントリを注入するかはプリセットが決定し、各エントリのトグルは一時的に効かなくなります。プリセットを外すと、それらのトグルに戻ります。圧縮プロンプトはプリセットに含まれません。セッションの「圧縮」チップで個別に指定してください。プリセットを切り替えても圧縮の選択は変わらないままです。'),
          h('div', { key: 'name', className: 'dsh-prompt-manager__surface' }, [
            h('div', { key: 'fields', className: 'dsh-prompt-manager__fields' }, [
              h('label', { key: 'name', className: 'dsh-prompt-manager__field dsh-prompt-manager__field--grow' }, [
                '名前（入力欄の切り替えボタンに表示されます）',
                h('input', {
                  key: 'input',
                  value: presetDraft.name,
                  placeholder: '例：CTF タスク',
                  disabled: busy,
                  onChange: (event) => setPresetDraft({ ...presetDraft, name: event.target.value }),
                }),
              ]),

            ]),
            h('div', { key: 'actions', className: 'dsh-prompt-manager__actions' }, [
              h(Button, {
                key: 'all',
                disabled: busy,
                onClick: () => setPresetDraft({ ...presetDraft, members: selectable.map((entry) => entry.id) }),
              }, `すべて選択（${String(selectable.length)}）`),
              h(Button, {
                key: 'none',
                disabled: busy || members.length === 0,
                onClick: () => setPresetDraft({ ...presetDraft, members: [] }),
              }, 'クリア'),
              h(Button, {
                key: 'save',
                variant: 'primary',
                disabled: !writable || busy,
                onClick: () => { void savePreset() },
              }, 'プリセットを保存'),
            ]),
          ]),
          selectable.length === 0
            ? h('div', { key: 'empty', className: 'dsh-prompt-manager__empty' }, 'チェックできる system prompt セクションがありません。リストページで「プロンプトを追加」してください。圧縮命令はプリセットに含まれないため、セッションで個別に指定してください。')
            : h('div', { key: 'members', className: 'dsh-prompt-manager__members' }, rows),
          missing.length === 0
            ? null
            : h('p', { key: 'missing', className: 'dsh-prompt-manager__note' },
              `このプリセットにはインデックスに存在しないエントリが含まれています：${missing.join('、')}。これらは注入されません。サブスクライブで取得できれば自動的に有効になります。`),
          statusLine,
        ])
      }

      // ── the preset list ─────────────────────────────────────────────────────

      if (view === 'presets') {
        const cards = presets.map((preset) => {
          // No card is badged as in force: no combination is in force *here*. A
          // combination is in force in a conversation, and each conversation says
          // so in its own composer.
          return h('div', { key: preset.id, className: 'dsh-prompt-manager__card' }, [
            h('button', {
              key: 'open',
              type: 'button',
              className: 'dsh-prompt-manager__cardMain',
              onClick: () => openPreset(preset),
            }, [
              h('span', { key: 'title', className: 'dsh-prompt-manager__title' }, preset.name),
              h('span', { key: 'meta', className: 'dsh-prompt-manager__meta' }, [
                preset.entries.length === 0
                  ? 'どのエントリも選択されていません（有効にしても1つも注入されません）'
                  : `${String(preset.entries.length)} 条 · ${preset.entries.slice(0, 4).map(titleOfEntry).join('、')}${preset.entries.length > 4 ? '…' : ''}`,

              ]),
            ]),
            h('div', { key: 'side', className: 'dsh-prompt-manager__cardSide' }, [
              h(RowMenu, {
                key: 'menu',
                open: menuFor === preset.id,
                label: `その他の操作：${preset.name}`,
                items: [
                  { id: 'edit', label: '編集', icon: icon('IconEditOutline16') },
                  { id: 'export', label: 'プリセットパッケージをエクスポート' },
                  // No "set as current" here any more: which combination is in force
                  // is the conversation's own choice, made from that conversation's
                  // composer, so a switch on this page could only mean "for every
                  // conversation at once" — which is what this change removed.
                  { id: 'delete', label: '削除', icon: icon('IconTrashOutline16'), disabled: !writable },
                ],
                onToggle: () => setMenuFor(menuFor === preset.id ? null : preset.id),
                onClose: () => setMenuFor(null),
                onSelect: (id) => {
                  setMenuFor(null)
                  if (id === 'edit') openPreset(preset)
                  else if (id === 'export') { void exportPreset(preset) }
                  else if (id === 'delete') { void removePreset(preset) }
                },
              }),
            ]),
          ])
        })

        return h('div', { className: 'dsh-prompt-manager' }, [
          h('div', { key: 'head', className: 'dsh-prompt-manager__head' }, [
            h(Button, { key: 'back', variant: 'ghost', disabled: busy, onClick: () => { setView('list'); setStatus(null) } }, '← 戻る'),
            h('h2', { key: 'title', className: 'dsh-prompt-manager__headTitle' }, 'プリセット'),
          ]),
          h('p', { key: 'lede', className: 'dsh-prompt-manager__intro' },
            'プリセット = 通常プロンプトの選択セットです。どのプリセットを使うかは各セッションが自分で決めます。セッション入力欄の「プロンプト」チップで切り替えてください。切り替えはそのセッションにのみ影響し、次のモデルステップから有効になります。プリセットは「どれを選ぶか」を決めるだけで、順序は各エントリの設定に従います。圧縮命令はセッションで個別に指定するため、プリセットの切り替えには追従しません。'),
          presets.length === 0
            ? h('div', { key: 'empty', className: 'dsh-prompt-manager__empty' }, 'プリセットがありません。「新規プリセット」を押して、いくつかプロンプトを選んでみてください。')
            : h('div', { key: 'cards', className: 'dsh-prompt-manager__list' }, cards),
          h('div', { key: 'addRow', className: 'dsh-prompt-manager__addRow' }, [
            h(AddButton, {
              key: 'add',
              disabled: !writable || busy,
              onClick: () => openPreset(null),
            }, '新規プリセット'),
            // A label wrapping the input, so the picker opens without a ref and
            // the control is a real file input rather than a lookalike button.
            h('label', {
              key: 'import',
              className: 'dsh-prompt-manager__addButton dsh-prompt-manager__fileLabel',
              'aria-disabled': !writable || busy,
            }, [
              'プリセットパッケージをインポート…',
              h('input', {
                key: 'file',
                type: 'file',
                accept: '.json,application/json',
                className: 'dsh-prompt-manager__fileInput',
                disabled: !writable || busy,
                onChange: (event) => {
                  const file = event.target.files === undefined || event.target.files === null
                    ? undefined
                    : event.target.files[0]
                  event.target.value = ''
                  void importPackFile(file)
                },
              }),
            ]),
          ]),
          statusLine,
        ])
      }

      // ── the list page ───────────────────────────────────────────────────────

      const visible = entries.filter((entry) => {
        if (filter === 'local') return !isSubscribed(entry)
        if (filter === 'subscribed') return isSubscribed(entry)
        return true
      })

      // The sections, which is what the switches and the enabled summary are
      // about: a compaction entry never enters the system prompt.
      const sectionEntries = entries.filter((entry) => !isCompaction(entry))

      const rows = visible.map((entry) => {
        const compaction = isCompaction(entry)
        // What this row can honestly report: the entry's own switch. Whether a
        // prompt actually reaches a model now depends on the combination the
        // conversation it belongs to chose, which this page cannot see — so it
        // shows the switch it owns and claims nothing about the rest.
        const injected = compaction ? false : entry.enabled === true
        const subscribed = isSubscribed(entry)
        const source = subscribed ? sourceById.get(entry.source) : undefined
        // The metadata line sits outside the row's button so the repository can be
        // a real link: an anchor nested in a button is neither valid markup nor
        // something a click can be trusted to split correctly. Parts are grouped so
        // the label and its link stay adjacent and only the links are underlined.
        //
        // A compaction entry's switch answers the pointer, so its line does not
        // restate that state: "現在の適用" beside the switch would say one thing twice.
        // What is left is where the body came from, and — while a combo is in force —
        // the fact that the combo, not the root pointer, is what answers for it.
        const meta = compaction
          ? [
            ['ローカル'],
            [],
          ].filter((group) => group.length > 0)
          : [
            subscribed
              ? source === undefined
                // The source is gone from the settings document, so the slug is all
                // that is left of where this body came from — a link would be dead.
                ? [`サブスクライブ ${entry.source}`]
                : [
                  'サブスクライブ ',
                  h('a', {
                    key: 'source',
                    className: 'dsh-prompt-manager__sourceLink',
                    href: `https://github.com/${source.repo}`,
                    target: '_blank',
                    rel: 'noreferrer',
                    title: `${source.repo}@${source.ref}（ソース ${source.id}）`,
                  }, source.repo),
                ]
              : ['ローカル'],
            [],
          ].filter((group) => group.length > 0)
        return h('div', {
          key: entry.id,
          className: 'dsh-prompt-manager__card',
        }, [
          h('div', { key: 'body', className: 'dsh-prompt-manager__cardBody' }, [
            h('button', {
              key: 'open',
              type: 'button',
              className: 'dsh-prompt-manager__cardMain',
              onClick: () => select(entry),
            }, h('span', { key: 'title', className: 'dsh-prompt-manager__title' }, entry.title)),
            h('span', { key: 'meta', className: 'dsh-prompt-manager__meta' },
              meta.flatMap((group, index) => (index === 0 ? group : [' · ', ...group]))),
          ]),
          h('div', { key: 'side', className: 'dsh-prompt-manager__cardSide' }, [
            h('span', {
              key: 'dot',
              className: `dsh-prompt-manager__dot${injected ? '' : ' dsh-prompt-manager__dot--idle'}`,
              'aria-hidden': 'true',
            }),
            compaction
              ? h('span', { key: 'badge', className: 'dsh-prompt-manager__badge dsh-prompt-manager__badge--compaction' }, '圧縮命令')
              : isSubscribed(entry)
                ? h('span', { key: 'badge', className: 'dsh-prompt-manager__badge' }, 'サブスクライブ')
                : null,
            // A section's switch answers `enabled`. A compaction entry has no
            // switch: its `enabled` flag decides nothing (`reconcile()` never gives
            // it a system-prompt section), and the pointer that used to make it live
            // is now one file per conversation. A control here could only write a
            // field nothing reads, or speak for every conversation at once — so the
            // row says where that choice actually lives instead.
            compaction
              ? h('span', { key: 'switch', className: 'dsh-prompt-manager__note' }, 'セッションごとに選択')
              : h(Switch, {
                key: 'switch',
                checked: injected,
                label: entry.title,
                disabled: !writable || busy,
                onChange: () => { toggle(entry, entry.enabled !== true) },
              }),
            h(RowMenu, {
              key: 'menu',
              open: menuFor === entry.id,
              label: `その他の操作：${entry.title}`,
              items: [
                { id: 'edit', label: '編集', icon: icon('IconEditOutline16') },
                // No "set as current" here any more: a compaction instruction is
                // chosen per conversation, from that conversation's own chip, so an
                // action on this page could only speak for every conversation at
                // once — the thing this change removed.
                { id: 'delete', label: '削除', icon: icon('IconTrashOutline16'), disabled: !writable },
              ],
              onToggle: () => setMenuFor(menuFor === entry.id ? null : entry.id),
              onClose: () => setMenuFor(null),
              onSelect: (id) => {
                setMenuFor(null)
                if (id === 'edit') select(entry)
                else if (id === 'delete') remove(entry)
              },
            }),
          ]),
        ])
      })

      const enabledCount = sectionEntries.filter((entry) => entry.enabled === true).length
      const ready = snapshot.status === 'ready'
      const note = snapshot.status === 'loading' || snapshot.status === null
        ? '設定を読み込み中…'
        : snapshot.status === 'unavailable'
          ? '設定名前空間が利用できません（loopback ではないページか、Host が settings をマウントしていません）。このページは読み取り専用です。'
          : null

      /**
       * What the Host reports about compaction, in one line.
       *
       * The field is absent rather than zero-valued while the feature is off, so
       * absence is exactly what "off" looks like from here. The two counts are
       * kept apart on purpose: a compaction that ran while the pointer was
       * elsewhere is the difference between "not working" and "not used yet", and
       * a page that merged them would report a number nobody could act on.
       * @returns the text for the status line under the controls.
       */
      const compactionReport = () => {
        // A failed read says nothing about the feature: reporting it as "off"
        // would be this page making up a fact about the deployment.
        if (storeUnreachable) return '圧縮命令：読み取れません（プロンプトストアに到達できません）'
        if (store === null || store.compaction === undefined || store.compaction === null) {
          return '圧縮命令：無効（設定項目 compaction: false）'
        }
        const report = store.compaction
        const matches = typeof report.matches === 'number' ? report.matches : 0
        const replacements = typeof report.replacements === 'number' ? report.replacements : 0
        const usage = replacements > 0
          ? `置き換え ${String(replacements)} 回`
          : matches > 0
            ? `${String(matches)} 回の圧縮を検出しましたが、まだ置き換えられていません`
            : '圧縮はまだ発生していません'
        // The counters are all this page can honestly say about the instruction:
        // which one is in force is a fact about a conversation, and the number of
        // replacements is what a person can match against a conversation's chip.
        return [
          '圧縮命令：セッションごとに選択',
          usage,
          typeof report.lastReplacedAt === 'string' && report.lastReplacedAt.length > 0
            ? `最終置き換え ${stamp(report.lastReplacedAt)}`
            : '',
        ].filter((part) => part.length > 0).join(' · ')
      }

      return h('div', { className: 'dsh-prompt-manager' }, [
        h('h1', { key: 'heading', className: 'dsh-prompt-manager__heading' }, 'プロンプト'),
        h('p', { key: 'lede', className: 'dsh-prompt-manager__intro' }, [
          '各プロンプトは、独立した system prompt section になるか、圧縮時に DSH 内蔵の命令を置き換えるテキスト（次回の圧縮から有効）のどちらかです。トグル・順序・本文の変更は次のモデルステップから有効になり、再起動は不要です。',
          'プラグインのリポジトリ：',
          h('a', {
            key: 'repo',
            className: 'dsh-prompt-manager__sourceLink',
            href: REPO_URL,
            target: '_blank',
            rel: 'noreferrer',
            title: `${REPO_SLUG}（このプラグインのリポジトリ）`,
          }, REPO_SLUG),
          // The ask sits outside the link on purpose: it is advice, not part of
          // the address, and a click meant for the repository should not land on
          // a sentence.
          ' もしよければスターをお願いします。',
        ]),
        h('p', { key: 'dir', className: 'dsh-prompt-manager__note' }, [
          `有効 ${String(enabledCount)}/${String(sectionEntries.length)}`,
          store !== null && typeof store.dir === 'string' ? `本文ディレクトリ：${store.dir}` : '',
        ].filter((part) => part.length > 0).join(' · ')),
        // The other half of "what is in force". A compaction instruction is never
        // a section, so nothing above this line would mention it — and the counts
        // are the only place a person can see whether it is being used at all.
        store === null ? null : h('p', { key: 'compaction', className: 'dsh-prompt-manager__note' }, compactionReport()),
        note === null ? null : h('p', { key: 'note', className: 'dsh-prompt-manager__note' }, note),
        // Which combination is in force is now a per-conversation fact, so this page
        // can no longer report one: it edits the combinations, the composer of each
        // conversation picks between them.
        h('p', { key: 'preset', className: 'dsh-prompt-manager__note' }, [
          'どのプリセットが有効かは各セッションが自分で決めます。セッション入力欄の「プロンプト」チップで切り替えてください。このページはプリセットの中身だけを管理します。',
          '各エントリのトグルは、そのセッションで「プリセット不使用」が選ばれているときだけ機能します。',
          '圧縮命令も同様です。このページは「どんな圧縮命令があるか」だけを管理し、「どれを使うか」はセッション入力欄の「圧縮」チップで選びます。',
        ]),
        storeUnreachable
          ? h('p', { key: 'unreachable', className: 'dsh-prompt-manager__status dsh-prompt-manager__status--error' }, [
            'プロンプトストアを読み取れないためエディタを無効化しました。トグルと順序の変更は引き続き使えます。',
            typeof store.error === 'string' && store.error.length > 0 ? store.error : '',
          ].filter((part) => part.length > 0).join(' '))
          : null,
        store !== null && store.ok !== false && store.writable === false
          ? h('p', { key: 'unwritable', className: 'dsh-prompt-manager__status dsh-prompt-manager__status--error' }, '本文ディレクトリに書き込めないためエディタを無効化しました。トグルと順序の変更は引き続き使えます。')
          : null,
        h('div', { key: 'list', className: 'dsh-prompt-manager__block' }, [
          h('div', { key: 'tabs', className: 'dsh-prompt-manager__tabs' }, [
            ...[['all', 'すべて'], ['local', 'ローカル'], ['subscribed', 'サブスクライブ']].map(([id, label]) => h('button', {
              key: id,
              type: 'button',
              className: filter === id ? 'dsh-prompt-manager__tab dsh-prompt-manager__tab--active' : 'dsh-prompt-manager__tab',
              onClick: () => setFilter(id),
            }, label)),
          ]),
          visible.length === 0
            ? h('div', { key: 'empty', className: 'dsh-prompt-manager__empty' }, filter === 'subscribed' ? 'サブスクライブしたプロンプトはまだありません。' : 'プロンプトがありません。「プロンプトを追加」を押して追加してください。')
            : h('div', { key: 'rows', className: 'dsh-prompt-manager__list' }, rows),
          h('div', { key: 'addRow', className: 'dsh-prompt-manager__addRow' }, [
            h(AddButton, { key: 'add', disabled: !writable || busy, onClick: add }, 'プロンプトを追加'),
            h(AddButton, {
              key: 'addCompaction',
              disabled: !writable || busy,
              onClick: () => { void addCompaction() },
            }, '圧縮命令を追加'),
            h(AddButton, {
              key: 'sources',
              icon: 'IconRefreshOutline16',
              disabled: busy,
              onClick: () => setView('sources'),
            }, `サブスクライブソース（${String(sources.length)}）`),
            h(AddButton, {
              key: 'variables',
              icon: 'IconEditOutline16',
              disabled: busy,
              onClick: () => { setView('variables'); setRunReport(null) },
            }, `変数（${String(knownVariables.length)}）`),
            h(AddButton, {
              key: 'presets',
              icon: 'IconEditOutline16',
              disabled: busy,
              onClick: () => { setView('presets'); setStatus(null); setMenuFor(null) },
            }, `プリセット（${String(presets.length)}）`),
          ]),
        ]),
        ready ? null : h('div', { key: 'waiting', className: 'dsh-prompt-manager__empty' }, '設定の読み込みが終わると、ここにリストが表示されます。'),
        statusLine,
        h('p', { key: 'foot', className: 'dsh-prompt-manager__note' }, [
          ready ? `settings revision ${String(snapshot.revision)}` : '',
          typeof snapshot.mode === 'string' ? ` · 永続化 ${snapshot.mode}` : '',
          ' · 本文はディスクファイルに、インデックスは settings.yaml に保存されます。サブスクライブエントリの本文は読み取り専用で、ソースは「ソース」ページで手動で更新を確認してください。',
        ].join('')),
      ])
    }

    /**
     * Keep one surface's failure from taking down the page it sits on.
     *
     * The settings section is one thing, but the preset chip lives in the
     * composer, where an exception would cost the input box itself — so the
     * label says which surface broke and the boundary stays as small as the
     * thing it wraps.
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error !== null) {
          const label = typeof this.props.label === 'string' ? this.props.label : 'プロンプトページ'
          return h('div', { className: 'dsh-prompt-manager__status dsh-prompt-manager__status--error', role: 'alert' },
            `${label}でエラー：${String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)}`)
        }
        return this.props.children
      }
    }

    /** Attach this bundle's stylesheet to the document. */
    function injectStyle() {
      const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)
      if (existing !== null) return null
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-prompt-manager'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return tag
    }

    const name = 'dsh-prompt-manager'

    // `configForms` is a hard requirement: this section is nothing but the
    // index it serves, so a host without the settings domain mounts nothing
    // rather than rendering controls that cannot persist. DSH 0.1.7 replaced the
    // per-plugin `settingsScope` service with `configForms`, whose forms are
    // keyed by Host entry id — which is why the namespace below is this
    // package's Loader entry id.
    //
    // `sessions` is deliberately not injected: both chips take the conversation's
    // id from the session-scoped slot they are drawn in, which is the same answer
    // without depending on a list snapshot — 0.1.6 dropped the `current` field the
    // 3.2.1 bundle read there, and that is what broke the switches.
    const inject = ['slots', 'configForms']

    /**
     * Register the settings section and the composer chip.
     *
     * One bundle, one settings form, two surfaces: the page where presets are
     * authored, and the control beside the input box that switches between them.
     * Both read the same namespace, so neither has to tell the other anything.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const scope = ctx.configForms.get(NAMESPACE)
      ctx.effect(() => {
        const tag = injectStyle()
        return () => { if (tag !== null) tag.remove() }
      }, 'prompt-manager: section styles')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NAMESPACE,
        order: SECTION_ORDER,
        label: () => 'プロンプト',
        inject: () => ({ scope }),
      }, (props) => h(Boundary, null, h(PromptSection, props))))
      // One injection, two entries: the row is a list, and the effect an `inject`
      // callback returns may be the iterable of disposers both registrations hand back.
      // The row is session-scoped, so each chip is handed the id of the conversation
      // the composer belongs to; the props are passed through as they arrive.
      ctx.slots.inject(PRESET_SLOT, () => [
        ctx.slots.register({
          name: PRESET_SLOT,
          id: NAMESPACE,
          order: 10,
        }, (props) => h(Boundary, { label: 'プロンプトプリセット' }, h(PresetChip, { ...props, scope }))),
        ctx.slots.register({
          name: PRESET_SLOT,
          id: COMPACTION_CHIP_ID,
          order: 11,
        }, (props) => h(Boundary, { label: '圧縮命令' }, h(CompactionChip, { ...props, scope }))),
      ])
    }

    return { name, inject, apply }
  },
})
