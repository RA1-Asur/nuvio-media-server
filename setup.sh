#!/usr/bin/env bash
# ==============================================================================
# Nuvio Cloud Vault - Interactive One-Shot Setup Script
# Configures GitHub Repository Secrets & Cloudflare Worker Secrets
# ==============================================================================

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "${CYAN}${BOLD}"
echo "=========================================================="
echo "    🎬 Nuvio Cloud Vault — Automated Infrastructure Setup"
echo "=========================================================="
echo -e "${NC}"
echo -e "This wizard configures your zero-cost automated video vault using:"
echo -e "  • Internet Archive (Storage & Byte-Range Direct Streaming)"
echo -e "  • GitHub Actions (Automated Ingestion & Transcoding)"
echo -e "  • Cloudflare Workers (Nuvio Addon Protocol & Web Dashboard)"
echo ""

# Helper to read input with default
prompt_input() {
    local prompt_text="$1"
    local default_val="$2"
    local is_secret="$3"
    local var_name="$4"
    local input_val=""

    if [ -n "$default_val" ]; then
        prompt_text="$prompt_text [default: $default_val]"
    fi

    if [ "$is_secret" = "true" ]; then
        read -rsp "$(echo -e "${BOLD}$prompt_text:${NC} ")" input_val
        echo ""
    else
        read -rp "$(echo -e "${BOLD}$prompt_text:${NC} ")" input_val
    fi

    if [ -z "$input_val" ]; then
        input_val="$default_val"
    fi

    eval "$var_name=\"\$input_val\""
}

# 1. Detect GitHub repository information
CURRENT_GH_OWNER=""
CURRENT_GH_REPO=""

if command -v git >/dev/null 2>&1; then
    REMOTE_URL=$(git config --get remote.origin.url 2>/dev/null || true)
    if [[ "$REMOTE_URL" =~ github\.com[:/]([^/]+)/([^/\.]+)(\.git)?$ ]]; then
        CURRENT_GH_OWNER="${BASH_REMATCH[1]}"
        CURRENT_GH_REPO="${BASH_REMATCH[2]}"
    fi
fi

# 2. Prompt for parameters
echo -e "${YELLOW}${BOLD}--- 1. Internet Archive S3 Credentials ---${NC}"
echo -e "Get your S3 Access and Secret Keys from: ${CYAN}https://archive.org/account/s3.php${NC}"
prompt_input "Enter IA_ACCESS_KEY" "" "false" IA_ACCESS_KEY
prompt_input "Enter IA_SECRET_KEY" "" "true" IA_SECRET_KEY
prompt_input "Enter IA_ITEM_ID (Vault Item Identifier)" "nuvio-cloud-vault-2026" "false" IA_ITEM_ID

echo ""
echo -e "${YELLOW}${BOLD}--- 2. Web Dashboard & GitHub Integration ---${NC}"
prompt_input "Enter ADMIN_PIN (Secret PIN for /dashboard ingestion)" "admin1234" "true" ADMIN_PIN

echo -e "\nGet a GitHub Personal Access Token (classic with 'repo' & 'workflow' scope) from: ${CYAN}https://github.com/settings/tokens${NC}"
prompt_input "Enter GITHUB_PAT" "" "true" GITHUB_PAT
prompt_input "Enter GitHub Owner / Username" "$CURRENT_GH_OWNER" "false" GH_OWNER
prompt_input "Enter GitHub Repository Name" "${CURRENT_GH_REPO:-nuvio-media-server}" "false" GH_REPO

echo ""
echo -e "${YELLOW}${BOLD}--- 3. Cloudflare Credentials (Optional for automated CI/CD) ---${NC}"
echo -e "Create a Workers API token from: ${CYAN}https://dash.cloudflare.com/profile/api-tokens${NC} (Template: 'Edit Cloudflare Workers')"
prompt_input "Enter CLOUDFLARE_API_TOKEN (optional, press Enter to skip)" "" "true" CF_TOKEN
prompt_input "Enter CLOUDFLARE_ACCOUNT_ID (optional, press Enter to skip)" "" "false" CF_ACCOUNT

# 3. Update wrangler.toml with public variables
echo ""
echo -e "${CYAN}[1/4] Updating wrangler.toml configuration...${NC}"
if [ -f "wrangler.toml" ]; then
    sed -i.bak -e "s|IA_ITEM_ID = \".*\"|IA_ITEM_ID = \"$IA_ITEM_ID\"|g" wrangler.toml
    sed -i.bak -e "s|GH_OWNER = \".*\"|GH_OWNER = \"$GH_OWNER\"|g" wrangler.toml
    sed -i.bak -e "s|GH_REPO = \".*\"|GH_REPO = \"$GH_REPO\"|g" wrangler.toml
    rm -f wrangler.toml.bak
    echo -e "${GREEN}✓ wrangler.toml updated successfully.${NC}"
fi

# 4. Save local .env file (for local testing / backup)
echo -e "${CYAN}[2/4] Writing local .env file (gitignored)...${NC}"
cat > .env <<EOF
IA_ACCESS_KEY=$IA_ACCESS_KEY
IA_SECRET_KEY=$IA_SECRET_KEY
IA_ITEM_ID=$IA_ITEM_ID
ADMIN_PIN=$ADMIN_PIN
GITHUB_PAT=$GITHUB_PAT
GH_OWNER=$GH_OWNER
GH_REPO=$GH_REPO
CLOUDFLARE_API_TOKEN=$CF_TOKEN
CLOUDFLARE_ACCOUNT_ID=$CF_ACCOUNT
EOF
chmod 600 .env
echo -e "${GREEN}✓ .env written securely.${NC}"

# Ensure .gitignore protects .env
if [ -f ".gitignore" ]; then
    if ! grep -q "^\.env$" .gitignore; then
        echo -e "\n.env\n.env.local\nnode_modules/\n.wrangler/\ndownloads/\n" >> .gitignore
    fi
else
    cat > .gitignore <<EOF
.env
.env.local
node_modules/
.wrangler/
downloads/
catalog_index.json
*.pyc
__pycache__/
EOF
fi

# 5. Set GitHub Repository Secrets via gh CLI
echo ""
echo -e "${CYAN}[3/4] Configuring GitHub Repository Secrets...${NC}"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    echo "Using GitHub CLI to set repository secrets on $GH_OWNER/$GH_REPO..."
    printf "%s" "$IA_ACCESS_KEY" | gh secret set IA_ACCESS_KEY -R "$GH_OWNER/$GH_REPO" || true
    printf "%s" "$IA_SECRET_KEY" | gh secret set IA_SECRET_KEY -R "$GH_OWNER/$GH_REPO" || true
    printf "%s" "$IA_ITEM_ID" | gh secret set IA_ITEM_ID -R "$GH_OWNER/$GH_REPO" || true

    if [ -n "$CF_TOKEN" ]; then
        printf "%s" "$CF_TOKEN" | gh secret set CLOUDFLARE_API_TOKEN -R "$GH_OWNER/$GH_REPO" || true
    fi
    if [ -n "$CF_ACCOUNT" ]; then
        printf "%s" "$CF_ACCOUNT" | gh secret set CLOUDFLARE_ACCOUNT_ID -R "$GH_OWNER/$GH_REPO" || true
    fi
    echo -e "${GREEN}✓ GitHub Repository Secrets configured.${NC}"
else
    echo -e "${YELLOW}Notice: 'gh' CLI not logged in or not installed.${NC}"
    echo -e "You can manually set these in ${CYAN}https://github.com/$GH_OWNER/$GH_REPO/settings/secrets/actions${NC}:"
    echo -e "  • IA_ACCESS_KEY"
    echo -e "  • IA_SECRET_KEY"
    echo -e "  • IA_ITEM_ID"
    echo -e "  • CLOUDFLARE_API_TOKEN (for automated deployments)"
    echo -e "  • CLOUDFLARE_ACCOUNT_ID (for automated deployments)"
fi

# 6. Set Cloudflare Worker Secrets via wrangler
echo ""
echo -e "${CYAN}[4/4] Configuring Cloudflare Worker Secrets...${NC}"
if command -v npx >/dev/null 2>&1; then
    echo "Setting Cloudflare Worker secrets..."
    printf "%s" "$ADMIN_PIN" | npx wrangler secret put ADMIN_PIN || true
    printf "%s" "$GITHUB_PAT" | npx wrangler secret put GITHUB_PAT || true
    echo -e "${GREEN}✓ Cloudflare Worker secrets uploaded.${NC}"
else
    echo -e "${YELLOW}Notice: Run 'npx wrangler secret put ADMIN_PIN' and 'npx wrangler secret put GITHUB_PAT' manually when deploying.${NC}"
fi

echo ""
echo -e "${GREEN}${BOLD}==========================================================${NC}"
echo -e "${GREEN}${BOLD}    ✅ SETUP COMPLETED SUCCESSFULLY!${NC}"
echo -e "${GREEN}${BOLD}==========================================================${NC}"
echo -e "Next steps:"
echo -e "  1. Deploy Worker:   ${CYAN}npx wrangler deploy${NC}"
echo -e "  2. Access Web UI:   ${CYAN}https://<your-worker-subdomain>.workers.dev/dashboard${NC}"
echo -e "  3. Add to Nuvio:    Add ${CYAN}https://<your-worker-subdomain>.workers.dev/manifest.json${NC} to Nuvio / Stremio addons"
echo ""
