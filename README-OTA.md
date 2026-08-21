# Remote ESP32-S3 firmware updates through Orange Pi

This project now includes an end-to-end OTA path:

`Administrator web app -> authenticated Orange Pi API -> protected ESP32-S3 OTA endpoint -> inactive OTA flash partition -> restart`

The **UPDATE** action is deliberately limited to approved Firebase users whose Realtime Database role is `administrator`. The Orange Pi verifies the Firebase ID token again on every OTA request; hiding the button in the browser is not treated as security.

## 1. Prepare the ESP32-S3 once by USB

Read `esp32-ota/README.md`, merge the handlers from `esp32_ota_receiver_example.ino` into the current irrigation firmware, select an OTA-capable partition scheme, and flash it once over USB.

Generate a strong shared token on the Orange Pi:

```bash
openssl rand -hex 32
```

Put the same value in the ESP32 `OTA_TOKEN` and later in the Orange Pi `ESP32_OTA_TOKEN`. Keep this value private.

## 2. Prepare Firebase credentials on Orange Pi

The browser's Firebase configuration is not enough for a trusted server. Download a Firebase service-account JSON for the existing project and store it outside any public route, for example:

```bash
sudo install -d -m 750 -o orangepi -g orangepi /opt/smart-irrigation/secrets
sudo install -m 600 -o orangepi -g orangepi firebase-service-account.json /opt/smart-irrigation/secrets/firebase-service-account.json
```

Never commit or send this JSON file with the project.

## 3. Install the Orange Pi server

The server requires Node.js 20 or newer.

```bash
cd /opt/smart-irrigation
npm install --omit=dev
cp .env.example .env
nano .env
```

Set at least:

- `GOOGLE_APPLICATION_CREDENTIALS`
- `ESP32_OTA_URL`
- `ESP32_STATUS_URL`
- `ESP32_OTA_TOKEN`
- `ALLOWED_ORIGINS` when a public HTTPS hostname is used

Make the firmware archive writable and run checks:

```bash
install -d -m 750 -o orangepi -g orangepi /opt/smart-irrigation/firmware-store
npm test
npm run check
npm start
```

Open `http://ORANGE_PI_IP:3000`, sign in as an Administrator, and use **Settings -> UPDATE**.

## 4. Run it continuously

Review the username and paths in `deploy/smart-irrigation.service`, then:

```bash
sudo cp deploy/smart-irrigation.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now smart-irrigation
sudo systemctl status smart-irrigation
```

For access from outside the local network, use a private VPN or put the Orange Pi behind an HTTPS reverse proxy. A sample Nginx configuration is included in `deploy/nginx-smart-irrigation.conf.example`. Do not expose the Node port or ESP32 OTA endpoint directly to the public internet.

## Update workflow

1. Compile the updated irrigation sketch as an **application `.bin`**.
2. Open Settings and press **UPDATE**.
3. Wait until the ESP32-S3 status is online.
4. Choose the `.bin`, optionally enter a version, tick the restart confirmation, and press **Upload & Install**.
5. The Orange Pi validates and archives the image, forwards it to the ESP32-S3, waits for acceptance, and records `firmware-store/last-update.json`.
6. The ESP32-S3 restarts. The page checks its status again after eight seconds.

Only application images beginning with the ESP32 image magic byte are accepted, upload size is limited, concurrent deployments are blocked, repeated attempts are rate-limited, and both the Firebase Administrator role and device OTA token are checked.

## Troubleshooting

- **Orange Pi online, ESP32-S3 unavailable:** verify the ESP32 IP, power, Wi-Fi, `ESP32_STATUS_URL`, token, and router firewall.
- **401/403 from Orange Pi:** sign in again and confirm `users/<uid>/status` is `approved` and `users/<uid>/role` is `administrator`.
- **Invalid ESP32 application image:** export the application firmware binary, not `bootloader.bin`, `partitions.bin`, or a merged factory image.
- **Not enough space / Update.begin failed:** select an OTA-capable partition layout with an inactive application slot large enough for the new image.
- **Web app is hosted elsewhere:** the browser code uses same-origin `/api/ota`. Serve the web files through this Orange Pi server or configure the reverse proxy so `/api/` reaches it under the same hostname.
