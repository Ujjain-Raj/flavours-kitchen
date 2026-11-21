# Flavours Kitchen – restaurant system

Run: double-click `start.bat` (or `node server.js`) → http://localhost:3000
Tablets/phones on the same Wi-Fi: use the LAN address printed in the console.

| Screen | URL | Demo PIN |
|---|---|---|
| Waiter | /waiter.html | 2222 |
| Kitchen display | /kitchen.html | 3333 |
| Admin | /admin.html | 1111 |

Change PINs in Admin > Staff before going live.

## Thermal printing (ESC/POS)
Admin > Printers: add up to 3 printers (KOT / Bill) with the printer's LAN IP, port 9100, 58mm or 80mm.
KOTs print automatically per kitchen station when the waiter sends an order; bills print from the waiter Bill screen.
Failed jobs retry 3 times, then appear in the print queue for reprint. A printer with no IP is a virtual
printer that saves text to `data/prints` (for testing without hardware). "Browser print" is a fallback.
USB-only printers need a network/print-server bridge (not included).

## Menu
Seeded from the handwritten category sheet. Dish names and prices are placeholders – edit in Admin > Menu (or CSV import).

Data lives in `data/db.json`.
Not yet built from the quote: customer QR site, payment gateway, inventory, reservations, messaging, cashier shifts.
