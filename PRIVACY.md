# Privacy policy

**Label chips for Gmail** · applies to version 1.8.0 and later · last updated
16 November 2026

## Summary

The add-on works entirely inside Thunderbird on your computer. It doesn't send
any data anywhere, collects no analytics or usage statistics, and shares
nothing with the developer or anyone else.

## What the add-on reads

To draw label chips and fill the label menus, the add-on reads data that
Thunderbird has already downloaded from your Gmail account and stored on your
computer:

- the Gmail labels of messages, and the names of your label folders
- for messages in the Inbox, your archive label folders and All Mail: the
  Message-ID, References and Gmail thread ID headers, to group messages into
  conversations for the archive hints

Thunderbird's add-on APIs also hand over basic details of the messages you
select or open, such as subject and sender; the add-on uses them only to find
those messages in other folders. It doesn't read message bodies or
attachments. Everything it reads stays in
Thunderbird's memory and is discarded when Thunderbird closes.

## What the add-on stores

In Thunderbird's local storage for add-ons, on your computer only:

- the color you picked for each label
- which labels you chose to show in the label menus

Uninstalling the add-on deletes this data.

## What the add-on changes

When you add or remove a label, the add-on asks Thunderbird to copy the message
into that label's folder or to delete it from there. Thunderbird sends these
changes to Gmail over its own mail connection, the same way it does when you
move a message yourself. The add-on also updates its local record of the
message's labels so the chips update straight away.

## Network access

The add-on makes no network requests of its own and has no permission to
contact any website.

Versions before 1.8.0 contacted the Gmail API (`gmail.googleapis.com`) using
Thunderbird's existing Google login, only to read the names and colors of your
labels. That data went from Google to your computer and nowhere else.
Version 1.8.0 removed this and deletes the colors and sync status those
versions stored, keeping the colors as your own picks.

## Permissions

| Permission | Why it's needed |
| --- | --- |
| Read your accounts and folders (`accountsRead`) | find your Gmail accounts and label folders |
| Read your messages (`messagesRead`) | read the labels of the messages you right-click or open |
| Move and copy messages (`messagesMove`) | add a label by copying a message to its folder |
| Delete messages (`messagesDelete`) | remove a label by deleting the message from that label's folder only |
| Menus (`menus`) | the right-click menu and the Label button's menu |
| Tabs (`tabs`) | draw chips in each mail tab |
| Storage (`storage`) | keep your colors and menu choices |
| Experiment API | draw chips on the message list and read Gmail labels, which no standard add-on API offers |

Thunderbird describes the Experiment API as full, unrestricted access to
Thunderbird and your computer. The add-on uses it only for the purposes above.
Its source code is unminified and public at
https://github.com/sabineschaller/thunderbird-gmail-label-chips.

## Changes to this policy

If a future version handles data differently, this policy will be updated
before that version is released.

## Contact

Questions about privacy or anything else:
https://github.com/sabineschaller/thunderbird-gmail-label-chips/issues
