import { registerSheet, SheetDefinition } from 'react-native-actions-sheet';
import { AttachSheet } from './AttachSheet';
import { ProfileSheet } from './ProfileSheet';
import { FabSheet } from './FabSheet';

registerSheet('attach-sheet', AttachSheet);
registerSheet('profile-sheet', ProfileSheet);
registerSheet('fab-sheet', FabSheet);

declare module 'react-native-actions-sheet' {
  interface Sheets {
    'attach-sheet': SheetDefinition<{ returnValue: 'media' | 'gif' }>;
    'profile-sheet': SheetDefinition;
    'fab-sheet': SheetDefinition;
  }
}

export {};
