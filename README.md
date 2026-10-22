# DeepSeek Usage

Omarchy bar widget for DeepSeek API usage: today's spend in the bar, and tokens,
requests, cache-hit rate, 7/30-day totals, per-model costs and (optionally) the
official account balance in the panel.

## Requirements

- Omarchy shell (Quickshell) with bar plugins.
- `curl`.
- A platform.deepseek.com account for usage data; a DeepSeek API key is optional
  and only used for the balance.

## Install

Manual, for a checkout in this directory:

```bash
cp -r alexpazzo.deepseek-usage ~/.config/omarchy/plugins/
omarchy-shell shell rescanPlugins
omarchy plugin enable alexpazzo.deepseek-usage --section right
```

Once the plugin lives in a git repository:

```bash
omarchy plugin add <git-url> --enable
```

## Token setup

Usage comes from the same backend as
[platform.deepseek.com/usage](https://platform.deepseek.com/usage), authorised by
the web session token your browser holds.

1. Sign in at <https://platform.deepseek.com/usage>.
2. Open the browser console and print the token:

   ```js
   JSON.parse(localStorage.getItem("userToken"))?.value ?? localStorage.getItem("userToken")
   ```

3. Save it in a file only your user can read:

   ```bash
   mkdir -p ~/.config/omarchy/deepseek-usage
   printf '%s' '<paste the token>' > ~/.config/omarchy/deepseek-usage/token
   chmod 600 ~/.config/omarchy/deepseek-usage/token
   ```

The token is a browser credential and expires after roughly 48 hours. When the
bar tooltip reports a session token expired, repeat step 2 and 3.

If the token already lives in a password store, point `tokenCommand` at it
instead of using a file — it runs through `bash -c` and prints the token on
stdout:

```bash
omarchy bar set alexpazzo.deepseek-usage tokenCommand 'secret-tool lookup service deepseek'
omarchy bar set alexpazzo.deepseek-usage tokenCommand 'pass show deepseek/token'
```

## Balance (optional)

The panel can show the official balance from `GET https://api.deepseek.com/user/balance`.
Either set `apiKeyFile` to a file containing an API key
(<https://platform.deepseek.com/api_keys>), or export `DEEPSEEK_API_KEY` for the
shell session. With neither, the balance section is hidden and usage still works.

## Settings

Change them with `omarchy bar set alexpazzo.deepseek-usage <key> <value>`.

| Key | Default | Meaning |
|---|---|---|
| `refreshIntervalSec` | `300` | Polling interval, 60–3600 seconds. |
| `tokenFile` | `~/.config/omarchy/deepseek-usage/token` | File holding the web session token. |
| `tokenCommand` | empty | Optional command that prints the token; overrides `tokenFile`. |
| `apiKeyFile` | empty | Optional file holding an API key for the balance call. |
| `endpointBase` | `https://platform.deepseek.com` | Advanced: host of the usage API. |
| `balanceBase` | `https://api.deepseek.com` | Advanced: host of `/user/balance`. |

## How it works

Each refresh makes two calls to the platform's usage API — one for amounts, one
for costs — for the last 30 local days:

```
GET {endpointBase}/api/v0/usage/by_api_key/amount?start=<sec>&end=<sec>&tz=<offset>
GET {endpointBase}/api/v0/usage/by_api_key/cost?start=<sec>&end=<sec>&tz=<offset>
Authorization: Bearer <session token>
```

`start` is local midnight 30 days ago, `end` is `start + 30 days`, and `tz` is
the east-positive offset in seconds. The session token is passed to the bundled
`fetch.sh` in its environment, never in argv; `fetch.sh` puts the bearer header
in a `0600` curl config inside `$XDG_RUNTIME_DIR` and deletes it on exit. The
plugin writes nothing outside the token files you create.

Left click opens the panel, middle click refreshes immediately, right click opens
platform.deepseek.com/usage.

## Pricing band

DeepSeek bills in two bands, defined in UTC:

- **Peak** — 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday.
- **Off-peak (discount)** — every other hour, weekends included.

Schedule source: <https://api-docs.deepseek.com/quick_start/pricing/> (effective
2026-08-16).

The panel's `PRICING` section shows the current band, the next flip and both peak
windows as local clock times, with the UTC offset stated in the `Next change`
label (e.g. `Next change (UTC+02:00)`); the weekday set stays UTC-anchored, which
the `Days` row makes explicit — a negative offset can push a window onto the
previous local day without moving the peak days. The bar figure is preceded by
the whale mark, tinted with the theme's `urgent` role during peak and with the
theme's normal foreground during off-peak — the same pairing colours the panel's
`Status` row, and nothing hard-codes a hex value, so both follow the active
theme. The bar tooltip appends `peak` or `off-peak` to the daily figure; the
tooltip itself is drawn by the shell as plain text in one colour, so the band
word there is not tinted. The band is computed locally from the clock — it is not
fetched — so it stays correct when an update fails and ticks on its own 30-second
timer.

## Troubleshooting

- **Session expired** — the token is older than ~48 hours or was revoked. Repeat
  [Token setup](#token-setup).
- **No session token** — the token file is missing, empty, or unreadable. Check
  the path shown in the panel, its permission (`chmod 600`), and that you copied
  only the token (or the JSON blob — both are accepted).
- **Update failed: …** — the request itself failed. Reproduce it with the same
  transport the widget uses (`tz` is the east-positive offset in seconds, `start`
  and `end` are local-shifted epochs; the values below are just one 30-day
  window):

  ```bash
  DS_TOKEN=$(cat ~/.config/omarchy/deepseek-usage/token) \
    bash ~/.config/omarchy/plugins/alexpazzo.deepseek-usage/fetch.sh \
    'https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=1700000000&end=1702592000&tz=7200' \
    | head -c 200
  ```

  A `{"code":40003,...}` body means the token is stale; `{"code":0,...}` means
  the endpoint moved or the shape changed — the widget deliberately has no
  second data source.
- **Bar shows `—`** — the widget has no fresh figure: hover it for the reason
  (not configured, expired, or update failed).
- **No data for today** — the platform only reports buckets it has seen; a day
  with no requests stays at `$0.00`.

## Tests

The parsing, aggregation and formatting logic is plain JavaScript and is checked
without QML:

```bash
node test-usage.js
node test-pricing.js
```
