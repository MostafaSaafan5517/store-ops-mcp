# Demo script: the order dashboard (60 to 90 seconds, silent)

A silent screen recording in claude.ai (Chrome) that shows the Store Ops dashboard rendered
inside the chat: live store data, a period switch, and a pending action that can only be
approved on the approval page.

## Before you record

- The deployed server is connected as a custom connector in claude.ai, signed in with "Try the
  demo" and all three scopes approved on the consent page.
- Use a fresh demo store (less than an hour old), so there are sold out products to restock.
- Chrome in a clean window: no bookmarks bar, no other tabs, no real names or emails anywhere.
  Only the Demo Store may be on screen.
- Zoom the page to about 110 percent so the dashboard text is readable in a small video.
- Allow pop-ups for claude.ai, so "Open approval page" can open a new tab.

## Shot 1: open the dashboard (0:00 to 0:15)

Type: `Show me my store dashboard.`

Do: wait for the dashboard to appear in the chat. Scroll slowly from the sales cards down to
the latest orders.

Viewer should notice: the "Demo Store" label, the sales cards (gross, refunds, net, orders,
average order), and the latest orders table with real looking but generated data.

## Shot 2: switch the period (0:15 to 0:25)

Do: click **7 days**, wait one second, then click **90 days**.

Viewer should notice: the numbers change at once, without a new message in the chat. The
dashboard asks the server directly for the new period.

## Shot 3: prepare a change (0:25 to 0:45)

Do: scroll to "Sold out" and read one product name and SKU from it. Type:
`Restock <SKU> by 5 units. Reason: new delivery.`

Do: when Claude answers that the change needs approval, scroll the dashboard to "Waiting for
approval" and click **Refresh**.

Viewer should notice: the action appears under "Waiting for approval" with a plain summary
("Change the stock of ... from 0 to 5") and an expiry time. There is no Approve button in the
dashboard.

## Shot 4: approve on the approval page (0:45 to 1:05)

Do: click **Open approval page**. Claude asks to open the link; allow it. In the new tab, pause
on the summary for two seconds, then click **Approve**. Close the tab.

Viewer should notice: the approval page is on the server's own address, with the same exact
summary. Approving happens there, signed in, never inside the chat.

## Shot 5: run it and refresh (1:05 to 1:25)

Type: `I approved it, go ahead.`

Do: when Claude confirms the stock change, click **Refresh** in the dashboard.

Viewer should notice: "Waiting for approval" is empty again, the product is no longer in
"Sold out". The change ran once, after a person approved it.

## After recording

- Trim any wait longer than two seconds.
- Check every frame for anything that is not the Demo Store before you publish.
