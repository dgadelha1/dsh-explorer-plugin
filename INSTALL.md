# Instalação — scripts prontos

Os scripts abaixo automatizam a instalação do **dsh-explorer-plugin** em um profile do DeepSeek Harness, encapsulando os passos documentados no [README](README.md#instalação-passo-a-passo-verificado):

| Script | Plataforma | Shell |
|---|---|---|
| `scripts/install.bat` | Windows | cmd (prompt/PowerShell) |
| `scripts/install.sh` | Linux | POSIX `sh` (bash, dash, zsh) |
| `scripts/install-macos.sh` | macOS | bash (macOS 3.2+ compatível) |

Os três compartilham a mesma interface e a mesma lógica: **validam os pré-requisitos, instalam o plugin e imprimem o próximo passo** (reiniciar o `dsh web`).

---

## Requisitos

| Pré-requisito | Versão | Observação |
|---|---|---|
| Node.js | ≥ 20 | Usado pela parte servidora (`fs.watch` recursivo) e para rodar o pnpm |
| CLI `dsh` | ≥ 0.1.0-rc.7 | Instalado via `npm install -g @deepseek-ai/dsh`; precisa estar no PATH |
| pnpm | ≥ 8 | No PATH **ou** cópia local em `.pnpm-home/` (ver abaixo) |

**Resolução do pnpm (automática, nesta ordem):**

1. `pnpm` no PATH do sistema → usado diretamente;
2. senão, a cópia local do checkout em `.pnpm-home/node_modules/pnpm/` → o script cria um shim em `.bin/pnpm` (`.bin\pnpm.cmd` no Windows) e o coloca no PATH **apenas para a duração do comando**;
3. senão → erro com dicas (`corepack enable` / `npm install -g pnpm` / `brew install pnpm`).

> `.pnpm-home/` e `.bin/` são regeneráveis e ficam no `.gitignore` — o shim criado na hora não suja o repositório.

---

## Uso rápido

### Windows (cmd ou PowerShell)

```bat
cd E:\caminho\para\dsh-explorer-plugin
scripts\install.bat
```

### Linux

```bash
cd /caminho/para/dsh-explorer-plugin
scripts/install.sh
```

### macOS

```bash
cd /caminho/para/dsh-explorer-plugin
scripts/install-macos.sh
```

> 💡 **Finder:** renomeie para `install-macos.command` (mantendo `chmod +x`) para abrir com duplo clique.

---

## Modos

Todos os scripts aceitam um argumento de modo:

| Comando | O que faz |
|---|---|
| `install.bat` (sem argumentos) | Instala o plugin no profile |
| `install.bat --check` | Valida os pré-requisitos **sem instalar** (somente leitura) e mostra o comando exato que seria executado |
| `install.bat --remove` | Remove o plugin do profile (também aceita `remove` / `uninstall`) |
| `install.bat --help` | Mostra o resumo de uso (também aceita `-h` / `help` / `/?`) |

Exemplos:

```bash
# Linux: validar antes de instalar
scripts/install.sh --check

# macOS: desinstalar
scripts/install-macos.sh --remove

# Windows: validar
scripts\install.bat --check
```

O modo `--check` é útil em CI ou antes de tocar no ambiente: ele imprime exatamente o comando `dsh plugin` que seria executado e o diretório do profile.

---

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `DSH_PROFILE` | `web` | Nome do profile onde o plugin é instalado/removido |
| `DSH_HOME` | `~/.dsh` (Linux/macOS) · `%USERPROFILE%\.dsh` (Windows) | Diretório raiz do DSH (o CLI `dsh` também respeita esta variável) |

Exemplo — instalar em outro profile:

```bash
DSH_PROFILE=my-profile scripts/install.sh
```

```bat
set DSH_PROFILE=my-profile
scripts\install.bat
```

---

## O que acontece por baixo dos panos

1. **Validação dos pré-requisitos** (com mensagens `[OK]` / `[AVISO]` / `[ERRO]`):
   - `node` (avisa se < 20);
   - CLI `dsh` (no Windows, com fallback para `%APPDATA%\npm\dsh.cmd`);
   - `pnpm` (PATH → `.pnpm-home/` → erro com dicas).
2. **Instalação**: executa o comando oficial documentado no README:

   ```bash
   dsh plugin --profile web add -w /caminho/absoluto/para/dsh-explorer-plugin
   ```

   - O caminho é **absoluto** (o CLI ancora specs relativos ao diretório de invocação);
   - A flag **`-w`** é obrigatória com pnpm ≥ 9 (evita `ERR_PNPM_ADDING_TO_ROOT`);
   - O CLI inicializa o profile no primeiro uso e **reconcilia automaticamente** a lista `dsh.profile.bundles` (o plugin entra na pilha de camadas do boot).
3. **Próximo passo**: o script imprime a instrução de reiniciar o `dsh web` — a composição dos bundles acontece no **boot**, então reiniciar é obrigatório para o painel aparecer. O script **não** reinicia o servidor sozinho, para não derrubar uma GUI em uso.

Verificação rápida após instalar (o profile `web` deve ficar assim):

```jsonc
{
  "name": "dsh-profile-web",
  "dependencies": {
    "dsh-explorer-plugin": "link:/caminho/absoluto/para/dsh-explorer-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-explorer-plugin"]
    }
  }
}
```

---

## Desinstalação

```bash
scripts/install.sh --remove          # Linux
scripts/install-macos.sh --remove    # macOS
scripts\install.bat --remove         # Windows
```

Equivale a `dsh plugin --profile web remove dsh-explorer-plugin`: o pnpm remove a dependência e o CLI **retira o pacote da lista `dsh.profile.bundles`** automaticamente. Reinicie o `dsh web` em seguida.

---

## Solução de problemas

| Sintoma | Causa / solução |
|---|---|
| `'pnpm' não é reconhecido` / `pnpm not found on PATH` | O script usa o shim local `.pnpm-home/` automaticamente; se ele não existir, instale o pnpm (`corepack enable`, `npm install -g pnpm` ou `brew install pnpm`) e rode de novo |
| `ERR_PNPM_ADDING_TO_ROOT` | Faltou a flag `-w` — os scripts já a incluem; se ocorrer ao rodar manualmente, use `dsh plugin --profile web add -w <caminho>` |
| `CLI 'dsh' não encontrado` | Instale com `npm install -g @deepseek-ai/dsh` (no Windows o script também procura em `%APPDATA%\npm\dsh.cmd`) |
| O painel não aparece após instalar | Reinicie o `dsh web` (a composição de bundles ocorre no boot) e recarregue a página |
| O `.bat` terminava sozinho depois do `dsh` | Bug de versões antigas do script (shim npm exige `call`); atualize o `scripts/install.bat` — a versão atual usa `call dsh ...` |
| Profile errado | Use `DSH_PROFILE=<nome>` para escolher o profile (padrão: `web`) |

---

## Notas de implementação (Windows)

- **`call` é obrigatório para o `dsh` em `.bat`:** o `dsh.cmd` é um shim npm que termina com `goto #_undefined_#`; invocado de um batch **sem `call`**, o `goto` falho encerra o batch chamador inteiro (sintoma: o script morre logo após o comando do `dsh`). Os scripts usam `call dsh ...` — mesma regra vale para **qualquer** shim npm (`pnpm`, `npm`, `npx`, ...) invocado de um `.bat`.
- **Parênteses em `echo` dentro de blocos `if (...)`:** texto com `(`/`)` não escapados quebra o parser do cmd (`. foi inesperado neste momento`); usamos `^(...^)` quando necessário.
- **`%%` em arquivos `.bat`:** dentro de um arquivo batch, `%%` vira `%` literal — é assim que o shim do pnpm é gravado com o `%*`/`%~dp0` corretos.
- As mensagens do `.bat` são ASCII para máxima compatibilidade de codepage do cmd.

---

## Referências

- [README — Instalação passo a passo](README.md#instalação-passo-a-passo-verificado)
- [SPEC.md — Especificação técnica](SPEC.md)
