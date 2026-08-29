#!/usr/bin/env bash
# install-macos.sh - instala/remove o dsh-explorer-plugin em um profile do DSH (macOS).
#
# Uso:
#   scripts/install-macos.sh                instala o plugin (profile padrao: web)
#   scripts/install-macos.sh --check        valida pre-requisitos sem instalar
#   scripts/install-macos.sh --remove       remove o plugin do profile
#   scripts/install-macos.sh --help         mostra esta ajuda
#
# Variaveis de ambiente:
#   DSH_PROFILE   nome do profile (padrao: web)
#   DSH_HOME      diretorio home do DSH (padrao: ~/.dsh)
#
# O que faz:
#   1. Valida node, o CLI 'dsh' e o pnpm (PATH primeiro; se ausente, usa a
#      copia local em .pnpm-home/, criando um shim em .bin/pnpm).
#   2. Executa: dsh plugin --profile <profile> add -w <checkout>
#   3. Imprime o proximo passo: reiniciar o 'dsh web' e recarregar a GUI.
#
# Dica: para abrir com duplo clique no Finder, renomeie para
#   install-macos.command   (e mantenha a permissao de execucao: chmod +x).
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CHECKOUT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
PROFILE="${DSH_PROFILE:-web}"
MODE="install"

case "${1:-}" in
  --check|check) MODE="check" ;;
  --remove|remove|uninstall) MODE="remove" ;;
  --help|-h|help) MODE="help" ;;
esac

ok()   { printf '[OK]   %s\n' "$1"; }
warn() { printf '[AVISO] %s\n' "$1"; }
err()  { printf '[ERRO]  %s\n' "$1"; }

usage() {
  cat <<'EOF'
Uso:
  scripts/install-macos.sh                instala o plugin (profile padrao: web)
  scripts/install-macos.sh --check        valida pre-requisitos sem instalar
  scripts/install-macos.sh --remove       remove o plugin do profile
  scripts/install-macos.sh --help         mostra esta ajuda

Variaveis de ambiente:
  DSH_PROFILE   nome do profile (padrao: web)
  DSH_HOME      diretorio home do DSH (padrao: ~/.dsh)
EOF
}

[ "$MODE" = "help" ] && { usage; exit 0; }

# --- 0. plataforma ----------------------------------------------------------
if [ "$(uname -s)" != "Darwin" ]; then
  warn "Este script foi feito para macOS. Em Linux, use scripts/install.sh."
fi

# --- 1. node ---------------------------------------------------------------
NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ]; then
  err "Node.js nao encontrado no PATH."
  err "Instale com o Homebrew (brew install node) ou via nvm e tente novamente."
  exit 1
fi
NODE_VERSION=$(node --version 2>/dev/null || echo "?")
NODE_MAJOR=${NODE_VERSION#v}
NODE_MAJOR=${NODE_MAJOR%%.*}
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  warn "Node.js $NODE_VERSION detectado; o plugin exige Node >= 20 (fs.watch recursivo)."
fi
ok "node $NODE_VERSION ($NODE_BIN)"

# --- 2. CLI dsh ------------------------------------------------------------
DSH_BIN=$(command -v dsh || true)
if [ -z "$DSH_BIN" ]; then
  err "CLI 'dsh' nao encontrado no PATH."
  err "Instale com: npm install -g @deepseek-ai/dsh"
  NPM_PREFIX=$(npm config get prefix 2>/dev/null || true)
  if [ -n "$NPM_PREFIX" ]; then
    warn "Se ja instalou, adicione ao PATH: export PATH=\"$NPM_PREFIX/bin:\$PATH\""
  fi
  exit 1
fi
ok "dsh ($DSH_BIN)"

# --- 3. pnpm ---------------------------------------------------------------
PNPM_BIN=$(command -v pnpm || true)
PNPM_SOURCE="PATH"
if [ -z "$PNPM_BIN" ]; then
  VENDORED_PNPM="$CHECKOUT_DIR/.pnpm-home/node_modules/pnpm/bin/pnpm.cjs"
  if [ -f "$VENDORED_PNPM" ]; then
    if [ "$MODE" != "check" ]; then
      mkdir -p "$CHECKOUT_DIR/.bin"
      {
        echo '#!/bin/sh'
        echo "exec node \"$VENDORED_PNPM\" \"\$@\""
      } > "$CHECKOUT_DIR/.bin/pnpm"
      chmod +x "$CHECKOUT_DIR/.bin/pnpm"
    fi
    PATH="$CHECKOUT_DIR/.bin:$PATH"
    export PATH
    PNPM_BIN="$CHECKOUT_DIR/.bin/pnpm"
    PNPM_SOURCE="copia local (.pnpm-home; shim em .bin/pnpm)"
  else
    err "pnpm nao encontrado no PATH e nao ha copia local em .pnpm-home/."
    err "Instale o pnpm (brew install pnpm / corepack enable / npm install -g pnpm) e tente novamente."
    exit 1
  fi
fi
ok "pnpm ($PNPM_BIN, via $PNPM_SOURCE)"

PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE"

# --- modo --check (somente leitura) ----------------------------------------
if [ "$MODE" = "check" ]; then
  printf '\n'
  ok "Tudo pronto. Comando que seria executado:"
  printf '      dsh plugin --profile %s add -w "%s"\n' "$PROFILE" "$CHECKOUT_DIR"
  printf '      profile: %s\n' "$PROFILE_DIR"
  exit 0
fi

# --- remocao ---------------------------------------------------------------
if [ "$MODE" = "remove" ]; then
  printf '==> Removendo dsh-explorer-plugin do profile '\''%s'\''...\n' "$PROFILE"
  dsh plugin --profile "$PROFILE" remove dsh-explorer-plugin
  status=$?
  if [ "$status" -ne 0 ]; then
    printf '\n'
    err "A remocao falhou (codigo $status). Confira a mensagem acima."
    exit "$status"
  fi
  printf '\n'
  ok "Plugin removido. Reinicie o 'dsh web' e recarregue a pagina."
  exit 0
fi

# --- instalacao ------------------------------------------------------------
printf '==> Instalando dsh-explorer-plugin no profile '\''%s'\''...\n' "$PROFILE"
printf '    comando: dsh plugin --profile %s add -w "%s"\n' "$PROFILE" "$CHECKOUT_DIR"
dsh plugin --profile "$PROFILE" add -w "$CHECKOUT_DIR"
status=$?
if [ "$status" -ne 0 ]; then
  printf '\n'
  err "A instalacao falhou (codigo $status). Confira a mensagem do pnpm acima."
  exit "$status"
fi

cat <<EOF

Instalacao concluida!

Proximo passo - reinicie o servidor web para o novo bundle entrar no boot:
  * Pare o 'dsh web' e suba de novo, por exemplo:
        pkill -f "dsh web" ; nohup dsh web >/tmp/dsh-web.log 2>&1 &
  * Depois recarregue a GUI: open http://127.0.0.1:3080

Para remover depois:  scripts/install-macos.sh --remove
EOF
exit 0
