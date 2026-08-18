# dsh-explorer-plugin

**DSH File Explorer** — árvore de arquivos do workspace + editor Monaco com gramáticas TextMate reais do VS Code, dentro da GUI web do DeepSeek Harness.

![versão](https://img.shields.io/badge/versão-0.2.0-blue) ![licença](https://img.shields.io/badge/licença-MIT-green)

- **Autor:** [dgadelha](https://github.com/dgadelha1)
- **Repositório:** https://github.com/dgadelha1/dsh-explorer-plugin
- **Licença:** MIT
- **Documentos relacionados:** [Especificação técnica (PT)](SPEC.md) · [Especificação (EN)](SPEC.en.md) · [Resumo de marketing (PT)](MARKETING.md) · [Marketing (EN)](MARKETING.en.md)

---

## O que é

Plugin para o **DeepSeek Harness (DSH)** que adiciona à GUI web um painel **explorer de arquivos + editor de código** no estilo VS Code: árvore do workspace da sessão com CRUD completo, editor **Monaco** com abas múltiplas, coloração de sintaxe com **gramáticas TextMate reais do VS Code** (28 linguagens), tema de ícones Seti + codicon, temas Dark+/Light+, integração com o agente (ações rápidas "Analisar"/"Corrigir") e locale seguindo a GUI (pt/en/zh).

O painel é **encaixado como uma coluna real da grade do app** — abre/fecha, redimensiona o chat, é colapsável, redimensionável e móvel (esquerda/direita).

---

## Funcionalidades

- 📂 **Explorer completo**: abrir, criar, renomear, duplicar, mover e excluir arquivos/pastas; carregamento sob demanda; ocultos opcionais
- ✏️ **Editor Monaco**: números de linha, abas, undo/redo, Ctrl+S com detecção de conflito externo, quebra de linha opcional, arquivos grandes (até 50 MB) e binários tratados
- 🎨 **Coloração TextMate real do VS Code** para 28 linguagens + temas Dark+/Light+ que seguem o tema da GUI
- 🔄 **Watcher em tempo real** (SSE): a árvore atualiza quando o agente cria/edita arquivos
- ⚡ **Ações rápidas**: "Analisar" / "Corrigir" enviam o caminho do arquivo para o chat do agente
- 🌐 **Multilíngue**: pt / en / zh, seguindo o locale da GUI
- 🛡️ **Segurança**: toda operação confinada ao workspace da sessão (sandbox); proteção contra path traversal e symlink escapes; raiz validada no servidor

Detalhes completos na [especificação (SPEC.md)](SPEC.md).

---

## Requisitos

| Requisito | Versão | Observação |
|---|---|---|
| DeepSeek Harness | 0.1.0-rc.7 (testado) | CLI `dsh` disponível no PATH |
| pnpm | ≥ 8 (testado com 9.15.9) | Necessário no PATH para o comando `dsh plugin` |
| Node.js | ≥ 20 | Usado pela parte servidora (`fs.watch` recursivo) |

> ⚠️ **Neste workspace**, o pnpm não está no PATH do sistema. Use o shim local (`.bin/pnpm`) prefixando o PATH nos comandos abaixo:
> ```bash
> PATH="$PWD/.bin:$PATH" dsh plugin ...
> ```
> O cache do npm/pnpm fica dentro do workspace (`.npm-cache`) porque `~/.npm` está em montagem read-only.

---

## Instalação (passo a passo verificado)

> As instruções abaixo foram **testadas de ponta a ponta** contra o DSH 0.1.0-rc.7 + pnpm 9.15.9. O comando `dsh plugin` encaminha os argumentos para o pnpm rodando dentro do diretório do profile (`$DSH_HOME/profiles/<nome>`), instala o pacote e **reconcilia automaticamente** a lista `dsh.profile.bundles` do profile.

### Passo 1 — (Opcional) Garantir os assets do runtime

Os assets (`vendor/` — Monaco, Oniguruma, gramáticas, temas, ícones) **já estão commitados no repositório**: um clone fresco já vem com tudo e **não precisa** deste passo.

Execute `node scripts/vendor.mjs` apenas se quiser **atualizar/re-vendorizar** os assets para as versões pinadas (requer rede):

```bash
node scripts/vendor.mjs
```

### Passo 2 — Instalar o plugin no profile web

A partir do diretório do checkout do plugin:

```bash
dsh plugin --profile web add -w .
```

Ou, de qualquer diretório, com o caminho absoluto:

```bash
dsh plugin --profile web add -w /caminho/absoluto/para/dsh-explorer-plugin
```

> ⚠️ **A flag `-w` é obrigatória.** Sem ela, o pnpm (≥ 9) falha com `ERR_PNPM_ADDING_TO_ROOT`: o profile é um workspace root e o pnpm exige que a instalação no root seja explícita com `-w`/`--workspace-root`. Exemplo do erro que você veria sem a flag:
> ```
> ERR_PNPM_ADDING_TO_ROOT  Running this command will add the dependency to the
> workspace root, which might not be what you want - if you really meant it, make
> it explicit by running this command again with the -w flag (or --workspace-root).
> ```

O que acontece por baixo dos panos (verificado no código-fonte do CLI `dsh` e em teste real):

1. **Primeiro uso**: o profile é inicializado em `$DSH_HOME/profiles/web` (cria `package.json`, `cordis.patch.yml`, `pnpm-workspace.yaml` com os bundles do template).
2. **pnpm add** roda no diretório do profile; caminhos relativos (`.`, `../plugin`) são **ancorados ao diretório onde você invocou o `dsh`** — por isso `add -w .` funciona de dentro do checkout.
3. **Reconciliação**: como o pacote declara `dsh.bundle.patch` no `package.json`, ele é **adicionado automaticamente** à lista `dsh.profile.bundles` do profile.

Resultado esperado no `$DSH_HOME/profiles/web/package.json`:

```jsonc
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "dsh-explorer-plugin": "link:/caminho/absoluto/para/dsh-explorer-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-explorer-plugin"   // ← adicionado automaticamente
      ]
    }
  }
}
```

### Passo 3 — Reiniciar o `dsh web`

A varredura de plugins e a composição do loader acontecem no **boot** — é preciso **reiniciar o servidor web** para que o novo bundle entre na árvore de camadas:

```bash
# pare o dsh web atual e suba novamente
# (neste ambiente, o script do projeto faz isso de forma destacada):
scripts/restart-web.sh
```

> 🔄 **Mudanças apenas no cliente** (`lib/client.js`, `vendor/`) são servidas ao vivo com `Cache-Control: no-cache` — nesse caso basta **atualizar a página** do navegador, sem reiniciar.

### Passo 4 — Verificar

1. Abra a GUI do DSH (ex.: http://127.0.0.1:3080).
2. O painel **File Explorer** deve aparecer na lateral (colapsável/móvel esquerda-direita).
3. Com uma sessão ativa, a árvore mostra o workspace; sem sessão, aparece o fluxo "abrir pasta".

### Para remover

```bash
dsh plugin --profile web remove dsh-explorer-plugin
```

A reconciliação retira o pacote da lista `dsh.profile.bundles` automaticamente. Reinicie o `dsh web` em seguida.

---

## Uso rápido

| Ação | Como |
|---|---|
| Abrir/fechar o painel | Botão de toggle na borda da tela |
| Mover o painel | Botão de flip (esquerda/direita) |
| Redimensionar | Arraste a borda do painel / o divisor árvore-editor |
| Novo arquivo/pasta, duplicar, renomear, mover, excluir | Ações no hover do item da árvore |
| Salvar | `Ctrl+S` (com detecção de conflito externo) |
| Fechar aba | `×` na aba, middle-click ou `Ctrl+W` |
| Enviar arquivo para o agente | Botões **Analisar** / **Corrigir** na barra de status do editor |
| Alternar quebra de linha | Botão **Quebra** na barra de status |

---

## Estrutura do projeto

```
dsh-explorer-plugin/
├── package.json            # metadados + dsh.bundle.patch + dsh.client + exports
├── cordis.patch.yml        # camada de patch do bundle (insere o plugin servidor)
├── LICENSE                 # MIT
├── SPEC.md / SPEC.en.md    # especificação técnica (PT/EN)
├── MARKETING.md / MARKETING.en.md  # resumo de marketing (PT/EN)
├── lib/
│   ├── index.js            # plugin servidor (ESM): RPC, rotas estáticas, SSE/watcher
│   └── client.js           # bundle cliente (formato __ModuleLoader__) — sem build
├── src/                    # cópias-fonte (exportadas via ./src/*); sincronizadas com lib/
├── scripts/
│   ├── vendor.mjs          # baixa os assets para vendor/ (idempotente, versões pinadas)
│   ├── merge-themes.mjs    # JSONC → JSON estrito + merge da cadeia include dos temas
│   ├── sync.mjs            # copia src/ → lib/ (--check falha se divergirem; roda no prepack)
│   ├── server-test.mjs     # teste de regressão do servidor
│   ├── smoke-client.cjs    # smoke test do bundle (stub do loader em Node)
│   ├── syntax-test-driver.cjs  # teste headless do pipeline TextMate (Puppeteer + Firefox)
│   └── restart-web.sh      # reinicia o dsh web (útil neste ambiente)
└── vendor/                 # assets servidos em runtime (commitados no repo)
    ├── monaco/             # monaco-editor (build AMD min)
    ├── onig/               # vscode-oniguruma (onig.wasm + loader)
    ├── textmate/           # vscode-textmate
    ├── grammars/           # 28 gramáticas .tmLanguage.json oficiais + manifest
    ├── themes/             # dark_plus.json / light_plus.json (JSON estrito)
    ├── codicon/            # fonte codicon (UI/pastas)
    └── seti/               # fonte seti + tema de ícones (arquivos)
```

---

## Desenvolvimento

O projeto **não tem etapa de build**: `src/` é a fonte única e `lib/` é sincronizado por script (gate no `prepack`).

```bash
# sincronizar src/ → lib/
node scripts/sync.mjs

# checar se src/ e lib/ divergem (CI)
node scripts/sync.mjs --check

# testes (regressão do servidor + smoke test do bundle)
npm test

# re-vendorizar os assets (requer rede)
node scripts/vendor.mjs
```

> O teste headless do pipeline TextMate (`scripts/syntax-test-driver.cjs`, Puppeteer + Firefox) não faz parte do `npm test` — requer download do navegador.

### Arquitetura em resumo

- **Servidor** (`lib/index.js`, plugin Cordis): canal RPC `/explorer` com endpoints `fs/*` (stat, list, read, write, create, rename, move, delete) — leitura/escrita **direta**, sem passar pelo LLM; rotas estáticas `/explorer-assets` (Monaco, gramáticas, temas); SSE `/explorer/events` com watcher `fs.watch` (heartbeat, auto-recuperação sem derrubar o processo).
- **Cliente** (`lib/client.js`): bundle escrito à mão no formato `window.__ModuleLoader__.load({id, factory})`, dependendo apenas de `react`; o resto vem dos serviços do runtime do DSH (`slots`, `layout`, `connection`, `sessions`, `workspaces`, `locale`, `theme`). Cores 100% via tokens do design system (`--dsw-*`).

### Segurança

- Confinamento ao workspace: `path.resolve` + verificação de prefixo; `realpath` do ancestral mais profundo bloqueia escapes por symlink
- **Raiz validada no servidor** a cada chamada: só o cwd canônico de sessões vivas ou paths do workspace registry (nada de `/`, `/etc`, `~` pela API loopback)
- CSRF protegido pela plataforma (`isTrustedApiRequest`); detecção de binários; limites de payload (2 MB inline, 50 MB read/write)

---

## Solução de problemas

| Sintoma | Causa / solução |
|---|---|
| `pnpm not found on PATH` | Instale o pnpm ou use o shim local: `PATH="$PWD/.bin:$PATH" dsh plugin ...` |
| `ERR_PNPM_ADDING_TO_ROOT` | Faltou a flag `-w`: use `dsh plugin --profile web add -w <caminho>` |
| O painel não aparece após instalar | Reinicie o `dsh web` (a composição de bundles ocorre no boot) e recarregue a página |
| Editor sem cores | O provider TextMate registra após a grammar carregar; se persistir, recarregue a página (assets com `no-cache`) |
| A árvore não reflete arquivos do agente | Verifique o watcher: `fs.watch` recursivo exige Node ≥ 20; o SSE tem heartbeat de 25 s |
| Escrita fora do workspace bloqueada | Comportamento esperado (sandbox) — o servidor rejeita com `bad-request` |

---

## Licença

**MIT** — Copyright (c) 2026 dgadelha. Uso livre para uso pessoal e comercial, com manutenção do aviso de copyright. O software é fornecido "como está", sem garantias. Consulte o [LICENSE](LICENSE) completo.
