# dsh-explorer-plugin — Resumo para Marketing

> **DSH File Explorer**: o editor de arquivos estilo VS Code dentro do DeepSeek Harness.
> Versão **0.2.0** · Autor: **dgadelha1** · Licença: **MIT**

---

## 1. O que é

O **dsh-explorer-plugin** é um plugin de código aberto para o **DeepSeek Harness (DSH)** — a plataforma de agentes de IA da DeepSeek — que adiciona à interface web um **explorer de arquivos + editor de código completo, no estilo VS Code**, diretamente dentro do chat da GUI.

Na prática: enquanto o agente de IA trabalha no workspace da sessão, o usuário vê a **árvore de arquivos em tempo real** e pode **abrir, editar e salvar** qualquer arquivo com coloração de sintaxe profissional — sem sair da janela do agente.

**Problema que resolve:** antes, os arquivos do workspace eram invisíveis na GUI — o usuário só "via" o que o agente dizia. Com o plugin, o workspace fica **visual e editável**, com leitura/escrita direta (sem passar pela conversa do LLM).

---

## 2. Principais funcionalidades

### 📂 Explorer de arquivos completo
- **Árvore do workspace** da sessão atual, com carregamento sob demanda (lazy)
- **CRUD completo**: abrir, criar, renomear, duplicar, mover e excluir arquivos/pastas
- Pastas primeiro, ordenação alfabética; arquivos ocultos (dotfiles, `node_modules`) exibidos opcionalmente
- **Ícones do VS Code**: tema **Seti** para arquivos + **codicon** para pastas e ações de UI

### ✏️ Editor de código profissional (Monaco)
- **Monaco Editor** (o mesmo editor do VS Code): números de linha, abas múltiplas, undo/redo, minimap
- **Coloração de sintaxe TextMate real** do VS Code para **28 linguagens**: JavaScript/TypeScript (incl. React), Python, HTML/CSS/SCSS/LESS, JSON/JSONC, Markdown, YAML, Shell, C/C++, Go, Rust, Java, PHP, SQL, C#, Ruby, Lua, Swift, XML, PowerShell, Batch, INI…
- **Temas Dark+ e Light+ oficiais** do VS Code (seguem automaticamente o tema claro/escuro da GUI)
- **Salvar com Ctrl+S** (atalho), detecção de conflito externo com diálogo Sobrescrever/Recarregar/Cancelar
- Quebra de linha opcional, suporte a arquivos grandes (até 50 MB) e tratamento de binários

### 🔄 Integração com o agente
- **Watcher de arquivos em tempo real**: se o agente cria/edita arquivos, a árvore atualiza sozinha (SSE)
- **Ações rápidas "Analisar" e "Corrigir"**: um clique envia o caminho do arquivo para o chat do agente

### 🎨 UI integrada à plataforma
- Painel **encaixado na grade do app** — abre/fecha, **redimensiona o chat**, é **colapsável, redimensionável e móvel** (esquerda/direita)
- **100% aderente ao design system do DSH**: cores 100% via tokens do tema (zero cor hardcoded)
- **Multilíngue**: segue o idioma da GUI (Português, English, 中文)

### 🛡️ Segurança em primeiro lugar
- Todas as operações **confinadas ao workspace da sessão** (sandbox)
- Proteção contra path traversal e escapes via symlink (`realpath` + verificação de prefixo)
- O servidor **valida a raiz** em cada chamada — só permite cwd de sessões vivas ou workspaces registrados (nada de ler `/`, `/etc` ou `~` pela API)
- Detecção de binários, limites de tamanho de payload (anti OOM)

---

## 3. Tecnologias e bibliotecas

| Biblioteca | Versão | Papel |
|---|---|---|
| **monaco-editor** | 0.56.0 | Editor de código (build AMD, o mesmo do VS Code) |
| **vscode-textmate** | 9.3.2 | Motor de gramáticas TextMate (coloração de sintaxe) |
| **vscode-oniguruma** | 2.0.1 | Motor de regex Oniguruma compilado para WebAssembly (`onig.wasm`) |
| **VS Code grammars + temas** | commit fixo `2c0f00a` do microsoft/vscode | 28 gramáticas `.tmLanguage.json` oficiais + temas Dark+/Light+ |
| **Seti + codicon** | do VS Code | Ícones de arquivos e de interface |
| **React** | via runtime do DSH | Única dependência de runtime do cliente |
| **Cordis (framework do DSH)** | plataforma | Plugin de servidor (RPC, rotas estáticas, SSE) |
| **Node.js** | ≥ 20 | `fs.watch` recursivo (inotify) e APIs nativas |

**Destaque de engenharia:** o bundle do cliente é **escrito à mão** no formato de módulo do DSH (`window.__ModuleLoader__.load`), com **zero etapa de build e zero dependências de toolchain** — o plugin é reproduzível e roda **offline** (todos os assets são servidos pelo próprio plugin, sem CDN externa; versões pinadas para vendoring reprodutível).

---

## 4. Arquitetura em resumo

```
┌───────────────────────────── dsh-explorer-plugin ─────────────────────────────┐
│                                                                               │
│  Parte servidora (lib/index.js) — plugin Cordis                               │
│  ├─ Canal RPC /explorer  → endpoints fs/* (stat, list, read, write, create,   │
│  │                        rename, move, delete) — direto, sem passar pelo LLM │
│  ├─ Rotas estáticas /explorer-assets → Monaco, Oniguruma, grammars, temas     │
│  └─ SSE /explorer/events → watcher de arquivos em tempo real (fs.watch)       │
│                                                                               │
│  Parte cliente (lib/client.js) — bundle à mão, sem build                      │
│  ├─ Painel encaixado na grade do app (colapsável, móvel, redimensionável)     │
│  ├─ Árvore de arquivos com ícones Seti/codicon                                │
│  └─ Editor Monaco + abas + TextMate + ações rápidas (Analisar/Corrigir)       │
│                                                                               │
│  Assets vendored (vendor/) — monaco, onig, textmate, grammars, themes,        │
│  codicon, seti — servidos em runtime, funcionam offline                       │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **Comunicação**: RPC servidor↔cliente no canal `/explorer` — leitura/escrita **instantânea** e fora do histórico da conversa
- **Sem build**: `src/` é a fonte única; `lib/` é sincronizado por `scripts/sync.mjs` (gate no `prepack`)
- **Testes**: regressão do servidor (sandbox/allowlist, caps, watcher sem crash), smoke test do bundle em Node e teste headless do pipeline TextMate (Puppeteer + Firefox)

---

## 5. Instalação (para quem quiser testar)

```bash
# 1. Baixar os assets vendored (rede necessária)
node scripts/vendor.mjs

# 2. Adicionar o plugin ao profile web do DSH
dsh plugin --profile web add -w /caminho/absoluto/do/plugin

# 3. Reiniciar o dsh web
```

---

## 6. Autores e licença

- **Autor:** [dgadelha1](https://github.com/dgadelha1) — único autor/contribuidor
- **Repositório:** [github.com/dgadelha1/dsh-explorer-plugin](https://github.com/dgadelha1/dsh-explorer-plugin)
- **Licença:** **MIT** — Copyright (c) 2026 dgadelha1
  - Uso livre para uso pessoal, comercial e modificação
  - Basta manter o aviso de copyright
  - Software fornecido "como está", sem garantias
- **Status:** versão 0.2.0, código aberto e privado no npm (instalação via plugin do DSH)

---

## 7. Frases prontas para divulgação

> "Leve o poder do VS Code para dentro do seu agente de IA: edite o workspace em tempo real enquanto o agente trabalha."

> "O DeepSeek Harness agora tem um editor de código profissional — com syntax highlighting real, temas Dark+/Light+, watcher de arquivos e ações rápidas de IA — tudo integrado ao chat."

> "Open source, MIT, offline-first e 100% alinhado ao design system do DSH."
