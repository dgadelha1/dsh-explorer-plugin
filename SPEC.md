# DSH File Explorer — Especificação (v2, implementada)

Plugin para o DeepSeek Harness (DSH) que adiciona à GUI web um **explorer de arquivos + editor de código** no estilo VS Code: árvore do workspace da sessão com CRUD completo, editor Monaco com numeração de linhas, abas múltiplas, coloração de sintaxe com grammars TextMate reais do VS Code (tema de ícones Seti + temas Dark+/Light+), integração com o agente (ação rápida) e locale seguindo a GUI.

---

## 1. Visão geral

| Item | Decisão |
|---|---|
| Tipo | Pacote npm instalável no profile DSH via `dsh plugin` (bundle + cliente) |
| Parte servidora | Plugin Cordis (patch `cordis.patch.yml`) com o serviço de arquivos RPC |
| Parte cliente | Bundle **escrito à mão** no formato `window.__ModuleLoader__.load({id, factory})` — **sem etapa de build** (zero dependências de toolchain) |
| Acesso a arquivos | RPC direto servidor↔cliente (canal `/explorer`), **sem** passar pelo LLM |
| Raiz da árvore | Workspace da sessão atual (cwd da sessão); sem sessão → fluxo de abrir/criar workspace |
| Permissões | Respeita o sandbox da sessão: toda operação confinada à raiz do workspace |
| Editor | Monaco Editor (build AMD servida pelo próprio plugin) |
| Coloração | Grammars TextMate reais do VS Code (via `vscode-textmate` + `vscode-oniguruma` WASM) + temas Dark+/Light+ mesclados |
| Ícones | Fonte **codicon** do VS Code (UI/pastas) + tema de ícones **Seti** (arquivos, o padrão do VS Code) |
| Posição na UI | Painel **encaixado como coluna real da grade do app** (redimensiona o chat), colapsável, redimensionável e **móvel** (esquerda/direita) |
| Idioma | Segue o locale ativo da GUI (dicionários `pt`, `en`, `zh`) |
| Licença | MIT |

## 2. Estrutura do pacote

```
dsh-explorer-plugni/
├── package.json            # dsh.bundle.patch + dsh.client + exports
├── cordis.patch.yml        # insere a linha do plugin servidor
├── LICENSE                 # MIT
├── SPEC.md                 # este documento
├── lib/
│   ├── index.js            # plugin servidor (ESM): RPC, rotas estáticas, SSE/watcher
│   └── client.js           # bundle cliente (factory CJS do __ModuleLoader__) — fonte única, sem build
├── src/                    # cópias-fonte (exports ./src/*) mantidas sincronizadas
├── scripts/
│   ├── vendor.mjs          # baixa os assets para vendor/ (idempotente)
│   ├── merge-themes.mjs    # JSONC -> JSON estrito + merge da cadeia include dos temas
│   ├── smoke-client.cjs    # smoke test do bundle (loader stub em Node)
│   └── syntax-test-driver.cjs  # teste headless do pipeline TextMate (puppeteer + Firefox)
└── vendor/                 # assets servidos em runtime (commitados no repo)
    ├── monaco/             # monaco-editor (build AMD min; source maps removidos)
    ├── onig/               # vscode-oniguruma (onig.wasm + loader UMD)
    ├── textmate/           # vscode-textmate (release CJS/UMD)
    ├── grammars/           # .tmLanguage.json oficiais + manifest.json (escopo → arquivo)
    ├── themes/             # dark_plus.json / light_plus.json (JSON estrito, mesclados)
    ├── codicon/            # fonte codicon do VS Code (UI + pastas)
    └── seti/               # fonte seti + vs-seti-icon-theme.json (ícones de arquivo)
```

### 2.1 Metadados do package.json

```jsonc
{
  "name": "dsh-explorer-plugni",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./src/*": "./src/*",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-theme",
        "@deepseek-ai/dsh-client-locale"
      ]
    }
  }
}
```

O plugin servidor exporta `{ name: 'explorer', inject: ['webServer', 'connection'], apply(ctx) }`.

### 2.2 cordis.patch.yml

```yaml
- insert:
    - id: explorer
      name: 'dsh-explorer-plugni'
```

## 3. Parte servidora (`lib/index.js`)

### 3.1 Canal RPC `/explorer`

Registrado com `ctx.connection.rpc.handle('/explorer', handler, { authority: 'loopback' })`.
> O canal **não pode conter `/` interno** (`CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/`) — por isso `/explorer` e não `/rpc/explorer`.

Handler `(endpoint, payload, signal) → RpcResult`. O cliente chama `ctx.connection.rpc.call('/explorer', endpoint, payload)` → `POST /explorer/<endpoint>`.

Endpoints (todos com `{root, …}`; caminhos sempre relativos à raiz):

| endpoint | payload | retorno |
|---|---|---|
| `fs/stat` | `{root, path}` | `{exists, path, name, isDir, size, mtimeMs, hidden}` (missing → `{exists:false}`) |
| `fs/list` | `{root, path, includeHidden}` | `{path, entries:[{name,path,isDir,size,mtimeMs,hidden}]}` (pastas 1º, nome-sorted; dotfiles filtrados por `includeHidden`) |
| `fs/read` | `{root, path}` | `{content, size, mtimeMs}` — binário → `{binary:true}`; > 2 MB → `{tooLarge:true, size}` |
| `fs/readLarge` | `{root, path}` | conteúdo sem limite (usado para abrir read-only) |
| `fs/write` | `{root, path, content}` | `{written, mtimeMs, size}` (escrita atômica temp+rename; mkdir -p do pai) |
| `fs/create` | `{root, path, kind:'file'\|'dir'}` | `{path}` (falha `directory-exists` se já existe) |
| `fs/rename` | `{root, path, newName}` | `{path}` (mesmo diretório) |
| `fs/move` | `{root, path, targetDir}` | `{path}` (outro diretório; colisão → `directory-exists`) |
| `fs/delete` | `{root, path}` | `{deleted:true}` (arquivo ou pasta recursiva; raiz bloqueada) |

Regras:
- **Confinamento/sandbox**: `path.resolve(root, …)` + verificação de prefixo; caminhos existentes passam por `realpath` do ancestral mais profundo (bloqueia symlink que escape da raiz). Escapar → `bad-request`.
- `root` validado como diretório existente a cada chamada.
- Códigos de erro apenas do schema RPC compartilhado (`bad-request`, `directory-exists`, `directory-unreadable`, `internal`) — o schema do cliente rejeita códigos desconhecidos.
- Binário detectado por byte NUL nos primeiros 8 KB.

### 3.2 Rotas web (webServer)

| rota | tipo | função |
|---|---|---|
| `/explorer-assets` | prefix | serve `vendor/` com MIME correto e `Cache-Control: no-cache` |
| `/explorer/events` | exact | **SSE** do watcher: `data: {"type":"fs","root":...,"events":[...]}` (heartbeat 25 s; 503 sem watcher) |

### 3.3 Watcher

- `fs.watch(root, {recursive:true})` (Node ≥ 20, inotify) com debounce ~120 ms; fallback não-recursivo se recursivo falhar.
- Uma instância por raiz ativa, compartilhada entre conexões SSE (refcount por cliente).
- Eventos agrupados → broadcast para os clientes daquela raiz; o cliente faz refresh da árvore com debounce.

## 4. Parte cliente (`lib/client.js`)

### 4.1 Registro e arquitetura

- Bundle no formato `window.__ModuleLoader__.load({id:'dsh-explorer-plugni', factory})`, exportando `apply` + `inject`.
- `inject` (serviços): `['slots','layout','connection','sessions','workspaces','locale','theme']`.
- `apply(ctx)`: registra dicionários `explorer` (pt/en/zh) e o componente `ExplorerPanel` no slot `shell.overlay` (list, root) do `ui-layout`.
- Dependências de runtime do bundle: apenas `react` (via `require`); todo o resto via serviços do `ctx`. CSS injetado via `<style>` (reivindicado pelo `claimStyles`).
- Assets de runtime carregados por script clássico/fetch de `/explorer-assets` (monaco AMD via `loader.js` + `require.config({paths:{vs}})`; onig/textmate como UMD clássicos → `window.onig` / `window.vscodetextmate`; onig.wasm via `loadWASM({data})`).

### 4.2 Painel: encaixado na grade (redimensiona o chat)

- O painel é renderizado no `shell.overlay` do AppFrame, mas **participa do layout**: um efeito lê o `grid-template-columns` inline do AppFrame (localizado via `[data-shell-overlay]`), **insere a largura do painel como coluna** (lado esquerdo → após a sidebar do DSH; lado direito → no fim) e mantém a sincronização com as mudanças do app via `MutationObserver` (guard contra loop próprio por `lastSet`).
- O painel é `position:absolute` dentro do frame, alinhado à coluna inserida. Resultado: abrir o painel **encolhe o chat** (com a transição da grade do app).
- **Colapsável** (estado persistido em `localStorage` `dsh-explorer.prefs`); minimizado vira uma **pílula fina na borda da tela, altura média** (não sobrepõe session log / status bar).
- **Redimensionável**: grip na borda do painel (drag 1:1, transição da grade desativada durante o arrasto, 260–560 px) + **divisor vertical** árvore/editor (20–70%, persistido).
- **Móvel**: botão de flip esquerda/direita (seta indica o destino); estado persistido.

### 4.3 Árvore

- Nós carregados **lazy** (1 nível por expansão via `fs/list`); pastas primeiro, alfabético.
- **Ocultos por padrão** (dotfiles, `node_modules`…) com toggle no cabeçalho (persistido).
- **Ícones**: pastas = codicon do VS Code (âmbar `#dcb67a`, aberta/fechada); arquivos = **tema Seti oficial** (`vs-seti-icon-theme.json` + `seti.woff`), com look-up `fileNames → fileExtensions → languageIds → _default` e variantes claras/escuras; fallback codicon enquanto o Seti carrega.
- Ações por item (hover, glifos codicon): novo arquivo/pasta (pastas), duplicar (arquivos), renomear, mover, excluir (confirmação).
- **Watcher**: assina `/explorer/events?root=…`; refresh com debounce 300 ms; estado expandido preservado.
- Sem workspace: lista de workspaces + "Abrir pasta…" (`pickDirectory` + `create` + `startSession`).

### 4.4 Abas + editor Monaco

- Abas estilo VS Code (topo azul na ativa, ponto âmbar de modificado, fechar com ×, middle-click/Ctrl+W).
- **Fluxo único do Monaco** (evita corrida): `requireMonaco → ensureThemes → cria o editor (se preciso) → anexa o modelo da aba`; re-executa em troca de aba/readOnly/tema. Editor descartado no unmount do host.
- Opções: `lineNumbers:'on'`, minimap off, `automaticLayout`, fonte 13, `readOnly` por aba.
- **Temas**: `dark_plus.json`/`light_plus.json` são **JSONC + cadeia `include`** no repo do VS Code — o `scripts/merge-themes.mjs` os converte em **JSON estrito auto-contido** (65/64 regras, bg `#1E1E1E`/`#FFFFFF`) no vendoring. O editor só é criado após `defineTheme`, com fallback `vs-dark`/`vs` garantido (nunca branco no tema escuro).
- **Coloração TextMate**:
  - Provider registrado **somente após** a grammar carregar (antes disso o tokenizador nativo do Monaco mantém cores provisórias).
  - **Re-tokenização em dois passos**: `setModelLanguage(model,'plaintext')` → de volta ao id original (o Monaco ignora `setLanguageId` com o mesmo id — causa histórica de "editor sem cores").
  - Grammars por extensão→languageId→escopo (manifest); fallback Monarch quando não há grammar.
- **Ctrl+S** salva (com checagem de conflito por `mtimeMs`/`size` → diálogo Sobrescrever/Recarregar/Cancelar).
- **Binário** → aviso; **> 2 MB** → banner read-only com "Abrir mesmo assim".
- **Ação rápida**: "Analisar"/"Corrigir" na status bar → `sessions.binding(cur).prompt([{type:'text', text: '<Ação>: <path-relativo>'}], 'queue')`.

### 4.5 Status bar

- Barra azul `#007acc` estilo VS Code no editor: caminho do arquivo, tags read-only/não-salvo, botões Salvar (Ctrl+S), Analisar, Corrigir.
- Rodapé discreto do painel: raiz do workspace + contagem de abas; erros em vermelho.

## 5. Instalação (documentada/reproduzível)

1. pnpm não está no PATH do sistema: usar o **shim local** (`.bin/pnpm` → `node <workspace>/.pnpm-home/node_modules/pnpm/bin/pnpm.cjs`); o cache npm/pnpm fica **dentro do workspace** (`.npm-cache`) porque `~/.npm` está em montagem read-only.
2. `node scripts/vendor.mjs` (baixa monaco, oniguruma, textmate, grammars, temas, codicon, seti — rede necessária).
3. `PATH="$PWD/.bin:$PATH" dsh plugin --profile web add -w /caminho/absoluto` (a flag `-w` é exigida porque o profile é um pnpm workspace root).
4. **Reiniciar `dsh web`** (a varredura de client plugins e a composição do loader ocorrem no boot). Mudanças apenas no **cliente** (`lib/client.js`, `vendor/`) são servidas ao vivo com `no-cache` — basta atualizar a página.

## 6. Critérios de aceite (verificados)

- [x] Painel abre/fecha, move esquerda/direita, redimensiona (borda + divisor); estado persiste.
- [x] Abrir o painel **redimensiona o chat** (coluna na grade).
- [x] Árvore mostra o workspace da sessão; sem workspace, fluxo de abrir/criar.
- [x] CRUD completo (abrir, criar, renomear, duplicar, mover, excluir) com confirmações.
- [x] Editor Monaco com números de linha, abas, dirty indicator, Ctrl+S, undo/redo.
- [x] Tema do editor segue o harness (Dark+ escuro no tema escuro; nunca branco).
- [x] Coloração TextMate (validação do pipeline em Node: markdown/TS com scopes corretos; provider registrado pós-grammar + re-tokenização forçada).
- [x] Ícones VS Code: codicon (UI/pastas) + Seti (arquivos).
- [x] Conflito externo detectado (mtime) e tratado.
- [x] Watcher atualiza a árvore quando o agente cria/edita arquivos.
- [x] Ação rápida envia o caminho do arquivo para o chat.
- [x] Escrita fora da raiz bloqueada (sandbox).
- [x] Locale segue a GUI (pt-BR quando ativo; senão en/zh).

## 7. Decisões de arquitetura (por quê)

- **Sem build**: o formato do bundle cliente é um contrato estável (`__ModuleLoader__.load`); escrevê-lo à mão elimina tsdown/config e garante reprodutibilidade sem toolchain.
- **Assets servidos pelo próprio plugin**: `/explorer-assets` (roteamento webServer do DSH) — nada de CDN externa, funciona offline.
- **RPC próprio em vez de tools do agente**: leitura/escrita instantânea e fora do histórico da conversa; o sandbox é aplicado no servidor (confinamento à raiz).
- **JSONC → JSON no vendoring**: os temas do VS Code têm comentários e `include`; `response.json()` falharia em runtime (causa de editor branco).

## 8. Fora de escopo (v1)

- Drag & drop de arquivos, minimap, busca global (Ctrl+P), diff, integração git, múltiplos roots simultâneos, preview de imagens (apenas aviso de binário), edição remota multi-dispositivo, tema de ícones alternativo configurável (trocar o Seti é só substituir o mapping).
