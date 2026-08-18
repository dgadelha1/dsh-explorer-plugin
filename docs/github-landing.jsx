import React from 'react';
import { Github, Terminal, CheckCircle2, Code2, FolderTree, Cpu, ShieldCheck, Zap } from 'lucide-react';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-sky-500 selection:text-white">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur sticky top-0 z-50 px-6 py-4 flex justify-between items-center max-w-6xl mx-auto">
        <div className="flex items-center space-x-3">
          <span className="font-mono font-bold text-lg text-white">dsh-explorer-plugin</span>
          {/* TODO: keep this badge in sync with package.json version */}
          <span className="text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full border border-slate-700">v0.2.0 · MIT</span>
        </div>
        <a href="https://github.com/dgadelha1/dsh-explorer-plugin" target="_blank" rel="noreferrer" 
           className="flex items-center gap-2 text-sm bg-slate-900 hover:bg-slate-800 border border-slate-700 px-3 py-1.5 rounded-md transition-all">
          <Github size={16} /> GitHub
        </a>
      </header>

      <main className="max-w-5xl mx-auto px-6 pt-16 pb-24">
        {/* Hero Section */}
        <section className="text-center space-y-6">
          <span className="text-xs uppercase tracking-widest text-sky-400 font-semibold bg-sky-950/50 border border-sky-800/50 px-3 py-1 rounded-full">
            DeepSeek Harness plugin
          </span>
          <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight">
            Your agent's workspace, <span className="bg-gradient-to-r from-sky-400 to-blue-500 bg-clip-text text-transparent">visible and editable</span>.
          </h1>
          <p className="text-slate-400 max-w-2xl mx-auto text-lg">
            A VS Code-style file explorer and Monaco editor docked right into the DSH chat. Watch the agent work, then jump in and edit — no round-trip through the LLM.
          </p>
          
          <div className="flex justify-center gap-4 pt-4">
            <a href="https://github.com/dgadelha1/dsh-explorer-plugin" target="_blank" rel="noreferrer"
               className="bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold px-5 py-2.5 rounded-lg flex items-center gap-2 transition-all">
              <Github size={18} /> View on GitHub
            </a>
            <a href="#install" className="bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 font-medium px-5 py-2.5 rounded-lg transition-all">
              Install in 3 steps
            </a>
          </div>

          {/* Screenshot Container — w-fit mx-auto shrink-wraps the macOS-style
              frame to the screenshot's exact size (611x950 portrait);
              image scales down on small screens via max-w-full. */}
          <div className="mt-12 rounded-xl border border-slate-800 bg-slate-900/50 p-2 shadow-2xl w-fit max-w-full mx-auto">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800 text-xs text-slate-500">
              <span className="w-3 h-3 rounded-full bg-rose-500/80"></span>
              <span className="w-3 h-3 rounded-full bg-amber-500/80"></span>
              <span className="w-3 h-3 rounded-full bg-emerald-500/80"></span>
              <span className="ml-2 font-mono">dsh web · explorer panel</span>
            </div>
            {/* Screenshot: docs/screenshot-0.20.png. Relative path works when
                 deploying this page from docs/; use "docs/screenshot-0.20.png"
                 if the built page lives at the repo root. */}
            <img src="./screenshot-0.20.png" alt="DSH Explorer Plugin — File Explorer panel" className="rounded-b-lg w-auto max-w-full h-auto bg-slate-950" />
          </div>
        </section>

        {/* Stats Strip — all figures verified against the implementation (SPEC.md) */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4 my-20 py-8 border-y border-slate-800 text-center">
          <div><p className="text-3xl font-bold text-sky-400">28</p><p className="text-xs text-slate-400">languages highlighted</p></div>
          <div><p className="text-3xl font-bold text-sky-400">0</p><p className="text-xs text-slate-400">build steps</p></div>
          <div><p className="text-3xl font-bold text-sky-400">50 MB</p><p className="text-xs text-slate-400">max file size</p></div>
          <div><p className="text-3xl font-bold text-sky-400">100%</p><p className="text-xs text-slate-400">offline assets</p></div>
        </section>

        {/* Quick Install — commands verified end-to-end against dsh 0.1.0-rc.7 + pnpm 9.15.9 */}
        <section id="install" className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2"><Terminal size={20} className="text-sky-400"/> Try it</h2>
          <pre className="bg-slate-950 p-4 rounded-lg font-mono text-sm text-emerald-400 overflow-x-auto border border-slate-800">
{`# 1. (Optional) Re-vendor assets — vendor/ is committed, so a fresh clone
#    already ships everything; run this only to refresh pinned versions.
node scripts/vendor.mjs

# 2. Install the plugin into the web profile.
#    The -w flag is REQUIRED: without it pnpm fails with
#    ERR_PNPM_ADDING_TO_ROOT (the profile is a pnpm workspace root).
dsh plugin --profile web add -w .            # from the plugin checkout
#   or: dsh plugin --profile web add -w /absolute/path/to/dsh-explorer-plugin

# 3. Restart the web server (bundles are composed at boot)
dsh web`}
          </pre>
          <p className="text-xs text-slate-500 mt-3">
            Requires the <code className="text-slate-400">dsh</code> CLI and pnpm ≥ 8 on your PATH. Full details in the <a href="https://github.com/dgadelha1/dsh-explorer-plugin/blob/main/README.md" className="text-sky-400 hover:underline">README</a>.
          </p>
        </section>
      </main>
    </div>
  );
}
