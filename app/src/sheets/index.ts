import { registerSheet, SheetDefinition } from 'react-native-actions-sheet';
import { AttachSheet } from './AttachSheet';
import { ProfileSheet } from './ProfileSheet';
import { FabSheet } from './FabSheet';
import { EditProfileSheet } from './EditProfileSheet';
import { EditAvailableForSheet } from './EditAvailableForSheet';
import { BackupSeedSheet } from './BackupSeedSheet';
import { ExportDataSheet } from './ExportDataSheet';
import { DeleteAccountSheet } from './DeleteAccountSheet';
import { MemberActionsSheet } from './MemberActionsSheet';
import { EditOrgSheet } from './EditOrgSheet';
import { MessageActionsSheet } from './MessageActionsSheet';
import { EmojiPickerSheet } from './EmojiPickerSheet';
import { ComposeEmailSheet } from './ComposeEmailSheet';
import { EmailDetailSheet } from './EmailDetailSheet';
import type { InboxEmail } from '../stores/useInboxStore';

registerSheet('attach-sheet', AttachSheet);
registerSheet('profile-sheet', ProfileSheet);
registerSheet('fab-sheet', FabSheet);
registerSheet('edit-profile-sheet', EditProfileSheet);
registerSheet('edit-available-for-sheet', EditAvailableForSheet);
registerSheet('backup-seed-sheet', BackupSeedSheet);
registerSheet('export-data-sheet', ExportDataSheet);
registerSheet('delete-account-sheet', DeleteAccountSheet);
registerSheet('member-actions-sheet', MemberActionsSheet);
registerSheet('edit-org-sheet', EditOrgSheet);
registerSheet('message-actions-sheet', MessageActionsSheet);
registerSheet('emoji-picker-sheet', EmojiPickerSheet);
registerSheet('compose-email-sheet', ComposeEmailSheet);
registerSheet('email-detail-sheet', EmailDetailSheet);

declare module 'react-native-actions-sheet' {
  interface Sheets {
    'attach-sheet': SheetDefinition<{ returnValue: 'media' | 'gif' }>;
    'profile-sheet': SheetDefinition;
    'fab-sheet': SheetDefinition;
    'edit-profile-sheet': SheetDefinition;
    'edit-available-for-sheet': SheetDefinition;
    'backup-seed-sheet': SheetDefinition;
    'export-data-sheet': SheetDefinition;
    'delete-account-sheet': SheetDefinition;
    'member-actions-sheet': SheetDefinition;
    'edit-org-sheet': SheetDefinition;
    'message-actions-sheet': SheetDefinition;
    'emoji-picker-sheet': SheetDefinition;
    'compose-email-sheet': SheetDefinition<{ payload: { to?: string; subject?: string; replyToMessageId?: string } }>;
    'email-detail-sheet': SheetDefinition<{ payload: InboxEmail }>;
  }
}

export {};
