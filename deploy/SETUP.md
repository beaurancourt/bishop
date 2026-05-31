# Home-server auto-deploy

Push to `main` → a self-hosted GitHub Actions runner on the server pulls,
installs, and restarts the bot. The runner long-polls GitHub over an outbound
connection, so **no port forwarding or public endpoint is required** (works
behind NAT).

Below, replace `beau` with your server username. All commands run **on the
server**.

## 1. Install a modern Node (system-wide)

The system Node must be ≥ 20 and on the default PATH so the systemd service can
find it. Install via NodeSource (this replaces the old v12):

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs        # Debian/Ubuntu
node --version                         # v22.x, and `which node` -> /usr/bin/node
```

(On Fedora/RHEL use the `rpm` NodeSource script; on Arch, `sudo pacman -S nodejs npm`.)

## 2. Clone the repo and configure

The deploy assumes the clone lives at `~/bishop` for the runner's user.

```sh
git clone git@github.com:beaurancourt/bishop.git ~/bishop
cd ~/bishop
npm ci --omit=dev
cp .env.example .env
# edit .env and paste your DISCORD_TOKEN
```

## 3. Install the systemd service

```sh
# edit deploy/bishop.service: set User= and WorkingDirectory= for your box
sudo cp ~/bishop/deploy/bishop.service /etc/systemd/system/bishop.service
sudo systemctl daemon-reload
sudo systemctl enable --now bishop
systemctl status bishop          # should be active (running)
journalctl -u bishop -f          # live logs; look for "Bishop is online as ..."
```

## 4. Allow the runner to restart the service without a password

The runner runs as your user; give it passwordless sudo for **only** the
restart command:

```sh
echo 'beau ALL=(root) NOPASSWD: /usr/bin/systemctl restart bishop' \
  | sudo tee /etc/sudoers.d/bishop-deploy
sudo chmod 440 /etc/sudoers.d/bishop-deploy
sudo visudo -c                   # validate sudoers syntax
```

## 5. Register the self-hosted runner

In the repo on GitHub: **Settings → Actions → Runners → New self-hosted
runner**, pick Linux/x64, and copy the `config.sh` token it shows you (it's
short-lived and per-repo, so it isn't checked in here). Then on the server:

```sh
mkdir -p ~/actions-runner && cd ~/actions-runner
# use the download URL/version GitHub shows on that page:
curl -o actions-runner.tar.gz -L https://github.com/actions/runner/releases/download/vX.Y.Z/actions-runner-linux-x64-X.Y.Z.tar.gz
tar xzf actions-runner.tar.gz
./config.sh --url https://github.com/beaurancourt/bishop --token <TOKEN_FROM_GITHUB>
# install + start it as a service so it survives reboots:
sudo ./svc.sh install $(whoami)
sudo ./svc.sh start
```

The runner now shows as **Idle** under Settings → Actions → Runners.

## 6. Try it

```sh
git commit --allow-empty -m "trigger deploy" && git push
```

Watch the **Actions** tab on GitHub (or `journalctl -u bishop -f` on the
server). On push to `main` the workflow runs `git reset --hard origin/main`,
`npm ci --omit=dev`, and `sudo systemctl restart bishop`.

## Notes

- `git reset --hard origin/main` makes the server's clone match the remote
  exactly — don't keep manual edits in `~/bishop`; `.env` is gitignored so it's
  untouched.
- You can also trigger a deploy by hand from the Actions tab (workflow_dispatch).
- The workflow lives in `.github/workflows/deploy.yml`.
