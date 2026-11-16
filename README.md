# Gmail Label Chips

A Thunderbird add-on that shows your Gmail labels on the message list, in the
same colors you gave them in Gmail, and lets you add or remove labels without
leaving Thunderbird.

> [!NOTE]
> All of this add-on's code, icons and documentation were written with
> [Claude Code](https://claude.com/claude-code), Anthropic's AI coding tool.
> It was tested by hand in Thunderbird 159 on macOS with one Gmail account, but
> has had no formal code review. Read the code before installing it, because
> its Experiment API gives it full access to Thunderbird.

## Features

- **Label chips on cards.** In the cards view of the message list, each
  message's Gmail labels appear as colored chips below the subject. In the
  compact two-row layout they sit next to the subject. The Inbox label is
  shown too; other system labels (Important, Starred, Sent, ...) are not.
- **Gmail's colors.** Label colors are read from the Gmail API with the login
  Thunderbird already has, and re-synced every 6 hours. You can override any
  color in the add-on's options.
- **Label from the message list.** Right-click one or more messages and choose
  **Add Gmail Label**. Labels the messages already have are ticked; choosing a
  ticked label removes it.
- **Label from an open message.** A **Label** button in the message header, next
  to Reply and Forward, opens the same list for the displayed message.
- **Choose which labels the menus show.** By default every label is listed
  except `Archive`, `Archives` and their sub-labels. Change this in the options.
- **Archive hints in the Inbox.** If other messages in a conversation are
  already filed under an `Archive/…` or `Archives/…` label, Inbox cards show
  that label as a dashed chip, e.g. **→ Hiring**, so you know where to file the
  rest of the conversation. Hover over it for the full label name.

## Requirements

- Thunderbird 128 or later (developed and tested on Thunderbird 159, macOS)
- A Gmail account added to Thunderbird over IMAP, signed in with OAuth
  (Thunderbird's default for Gmail)
- In Gmail's settings under **Forwarding and POP/IMAP**: IMAP enabled, and
  **Auto-Expunge on** so that removing a label takes effect right away
- The **All Mail** folder subscribed in Thunderbird, so removing a label never
  removes a message from Gmail entirely

## Installation

1. Build the add-on (see [Development](#development)) or use a built
   `gmail-label-chips.xpi`.
2. In Thunderbird, open **Tools → Add-ons and Themes**, click the gear icon and
   choose **Install Add-on From File…**, then pick the `.xpi`.
3. Allow the permissions it asks for. The add-on uses an Experiment API, so
   Thunderbird shows it as having full access.
4. Switch the message list to the cards view if it isn't already
   (**View → Message List → Cards View**, or the list's display options).

When installing a new build over an old one, use a higher version number in
`manifest.json`, otherwise Thunderbird may keep the old code. Thunderbird only
updates the icon in the Add-ons Manager after a restart.

## Options

Open them from **Tools → Add-ons and Themes → Gmail Label Chips → Options**.

- **Colors from Gmail:** when colors were last synced, and a **Sync now** button.
- **Right-click menu:** tick the labels you want in both label menus, or use
  **Show all** / **Hide all**.
- **Label colors:** pick a different color for any label, or go back to
  **Use Gmail color**.

## How it works

- **Labels.** For Gmail accounts, Thunderbird stores each message's labels in the
  `X-GM-LABELS` header property. Gmail leaves out the label of the folder the
  message is in, so the add-on adds that one itself. The add-on patches the
  `thread-card` element of the message list to draw chips from this property.
- **Adding a label** copies the message to the label's folder, which is how
  Gmail's IMAP adds a label.
- **Removing a label** permanently deletes the message's copy from that label's
  folder. In Gmail's IMAP this removes only that label; the message stays in
  All Mail and keeps its other labels. Nothing goes to the Trash.
- **Archive hints** come from an index of the messages Thunderbird has
  downloaded in the archive label folders and in All Mail. Messages are
  grouped into conversations by Gmail's thread ID (`X-GM-THRID`), or by
  `Message-ID` and `References` when there is no thread ID. The index is
  rebuilt a few seconds after those folders change. Moving a message into an
  archive folder in Thunderbird updates the hints straight away.

## Known limitations

- Chips only appear in the cards view, not the table view.
- If an Inbox message shows no chips, Thunderbird may have downloaded it before
  it knew the account was Gmail. Right-click the Inbox, choose **Properties →
  Repair Folder**, and the labels come back.
- To remove a label from a message that's shown in another folder, Thunderbird
  needs that label's folder to have been opened at least once.
- Archive hints only know about messages Thunderbird has downloaded. Open an
  archive folder once, or turn on **Account Settings → Server Settings → Check
  all folders for new messages**, to keep them up to date.
- Label colors need the Gmail API to be reachable with Thunderbird's login. If
  syncing fails, labels use Gmail's default grey until you set a color by hand.

## Development

```
manifest.json         add-on manifest
background.js         color syncing, menus, adding and removing labels
api/schema.json       Experiment API definition
api/implementation.js Experiment API: chips, archive hints, label storage, OAuth
options/              options page
icons/icon.svg        add-on icon
icons/label-*.svg     toolbar button icon, one per Thunderbird theme
```

Build the `.xpi` from the project folder:

```sh
zip -r -X -q ../gmail-label-chips.xpi manifest.json background.js api options \
  icons/icon.svg icons/label-dark.svg icons/label-light.svg LICENSE
```

The toolbar icon files are named after the theme they're shown in:
`label-dark.svg` is the light icon for the dark theme, and `label-light.svg` is
the dark icon for the light theme. Thunderbird's schema description of
`theme_icons` suggests the opposite, but this is what Thunderbird 159 does on
screen.

To see errors, open **Tools → Developer Tools → Error Console** (background
script and Experiment API) or **Debug Add-ons → Inspect** (background page).

## License

Copyright © 2026 Sabine Schaller.

This project is licensed under the [Mozilla Public License 2.0](LICENSE).
