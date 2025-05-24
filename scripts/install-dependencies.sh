#!/bin/bash
#
# ┌─────────────────────────────────────────────┐
# │     Go & Mcumgr Installer                   │
# └─────────────────────────────────────────────┘

set -e  # Exit on error

# Colors for pretty output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${NC}"
echo -e "${BLUE}┃             Go & Mcumgr Installer                  ┃${NC}"
echo -e "${BLUE}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${NC}"

# Define Go version
GO_VERSION="1.20.5"
echo -e "${BLUE}➤ Installing Go version ${GO_VERSION}...${NC}"

# Check if wget is installed
if ! command -v wget &> /dev/null; then
    echo -e "${RED}✗ wget is not installed. Please install it first.${NC}"
    exit 1
fi

# Download Go
echo -e "${BLUE}➤ Downloading Go...${NC}"
if wget -q "https://dl.google.com/go/go${GO_VERSION}.linux-amd64.tar.gz"; then
    echo -e "${GREEN}✓ Go downloaded successfully${NC}"
else
    echo -e "${RED}✗ Failed to download Go${NC}"
    exit 1
fi

# Install Go
echo -e "${BLUE}➤ Installing Go...${NC}"
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf "go${GO_VERSION}.linux-amd64.tar.gz"
if [ -d "/usr/local/go" ]; then
    echo -e "${GREEN}✓ Go installed successfully${NC}"
else
    echo -e "${RED}✗ Failed to install Go${NC}"
    exit 1
fi

# Set up Go environment globally
echo -e "${BLUE}➤ Setting up Go environment globally...${NC}"

# Add to system-wide profile for all users
echo -e "${BLUE}➤ Adding Go paths to system-wide profile...${NC}"
sudo tee /etc/profile.d/go.sh > /dev/null << 'EOF'
# Go Environment Variables
export PATH=$PATH:/usr/local/go/bin:$HOME/go/bin
export GOPATH=$HOME/go
EOF

# Make the profile script executable
sudo chmod +x /etc/profile.d/go.sh

# Also add to current user's profile for immediate use
for PROFILE_FILE in ~/.bashrc ~/.profile ~/.bash_profile; do
    if [ -f "$PROFILE_FILE" ]; then
        # Check if entry already exists
        if ! grep -q "# Go Environment Variables" "$PROFILE_FILE"; then
            echo -e "${BLUE}➤ Adding Go paths to $PROFILE_FILE...${NC}"
            echo '' >> "$PROFILE_FILE"
            echo '# Go Environment Variables' >> "$PROFILE_FILE"
            echo 'export PATH=$PATH:/usr/local/go/bin:$HOME/go/bin' >> "$PROFILE_FILE"
            echo 'export GOPATH=$HOME/go' >> "$PROFILE_FILE"
        fi
    fi
done

# Create symlink for Go in /usr/local/bin for immediate access
echo -e "${BLUE}➤ Creating symlinks for immediate access...${NC}"
sudo ln -sf /usr/local/go/bin/go /usr/local/bin/go
sudo ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt

# Set variables for current session
export PATH=$PATH:/usr/local/go/bin:$HOME/go/bin
export GOPATH=$HOME/go

# Create GOPATH directories if they don't exist
mkdir -p $HOME/go/bin

# Verify Go installation
echo -e "${BLUE}➤ Verifying Go installation...${NC}"
if go version; then
    echo -e "${GREEN}✓ Go is properly installed and accessible${NC}"
else
    echo -e "${RED}✗ Go installation verification failed${NC}"
    exit 1
fi

# Install mcumgr
echo -e "${BLUE}➤ Installing mcumgr...${NC}"
go install github.com/apache/mynewt-mcumgr-cli/mcumgr@latest

# Verify mcumgr installation
if [ -f "$HOME/go/bin/mcumgr" ]; then
    echo -e "${GREEN}✓ mcumgr installed successfully${NC}"
    
    # Create a symbolic link to /usr/local/bin for system-wide access
    echo -e "${BLUE}➤ Making mcumgr available system-wide...${NC}"
    sudo ln -sf "$HOME/go/bin/mcumgr" /usr/local/bin/mcumgr
    
    echo -e "${BLUE}➤ mcumgr version:${NC}"
    mcumgr version
else
    echo -e "${RED}✗ Failed to install mcumgr${NC}"
    exit 1
fi

# Clean up downloaded files
echo -e "${BLUE}➤ Cleaning up...${NC}"
rm "go${GO_VERSION}.linux-amd64.tar.gz"

echo -e "${GREEN}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${NC}"
echo -e "${GREEN}┃     Installation Complete!                         ┃${NC}"
echo -e "${GREEN}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${NC}"
echo -e "${GREEN}✓ Go and mcumgr are now available system-wide!${NC}"
echo -e "${BLUE}➤ You can run these commands immediately in this terminal.${NC}"
echo -e "${BLUE}➤ For other terminal sessions, you may need to run:${NC}"
echo -e "${GREEN}source /etc/profile.d/go.sh${NC}"
echo -e "${BLUE}➤ or restart your terminal.${NC}"