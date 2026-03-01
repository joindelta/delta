# Phase 5 Integration Guide

## Quick Start

### 1. Install Dependencies
```bash
cd app
npm install react-native-nfc-manager react-native-qrcode-svg react-native-svg
```

### 2. Configure Platform Permissions

#### iOS
Add to `ios/DeltaApp/Info.plist`:
```xml
<key>NFCReaderUsageDescription</key>
<string>Delta needs NFC access to read invite tags</string>
```

Enable NFC capability in Xcode (see `phase5-nfc-setup.md` for details).

#### Android
Add to `android/app/src/main/AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.NFC" />
<uses-feature android:name="android.hardware.nfc" android:required="false" />
```

### 3. Rebuild Native Modules
```bash
# iOS
cd ios && pod install && cd ..
npx react-native run-ios

# Android
npx react-native run-android
```

## Using the Member Management UI

### Navigate to Member List
```typescript
import { OrgMemberButton } from '../components/OrgMemberButton';

// In your org screen component:
<OrgMemberButton 
  navigation={navigation} 
  orgId={org.orgId} 
  orgName={org.name} 
/>
```

Or navigate directly:
```typescript
navigation.navigate('MemberList', { 
  orgId: 'org-id-here', 
  orgName: 'Org Name' 
});
```

### Generate Invite Token
```typescript
navigation.navigate('Invite', { 
  orgId: 'org-id-here', 
  orgName: 'Org Name' 
});
```

### Add Member
```typescript
navigation.navigate('AddMember', { 
  orgId: 'org-id-here', 
  orgName: 'Org Name' 
});
```

## API Usage Examples

### Generate Invite Token
```typescript
import { generateInviteToken } from '../ffi/deltaCore';

const expiryTimestamp = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
const token = generateInviteToken(orgId, 'Read', expiryTimestamp);
console.log('Invite token:', token);
```

### Verify Invite Token
```typescript
import { verifyInviteToken } from '../ffi/deltaCore';

try {
  const info = verifyInviteToken(token, Date.now());
  console.log('Org ID:', info.orgId);
  console.log('Access Level:', info.accessLevel);
  console.log('Inviter:', info.inviterKey);
} catch (err) {
  console.error('Invalid or expired token');
}
```

### Add Member
```typescript
import { addMemberDirect } from '../ffi/deltaCore';

await addMemberDirect(orgId, memberPublicKey, 'Read');
```

### List Members
```typescript
import { listOrgMembers } from '../ffi/deltaCore';

const members = await listOrgMembers(orgId);
members.forEach(member => {
  console.log(member.publicKey, member.accessLevel);
});
```

### Change Permission
```typescript
import { changeMemberPermission } from '../ffi/deltaCore';

await changeMemberPermission(orgId, memberPublicKey, 'Write');
```

### Remove Member
```typescript
import { removeMemberFromOrg } from '../ffi/deltaCore';

await removeMemberFromOrg(orgId, memberPublicKey);
```

## Access Levels

```typescript
type AccessLevel = 'Pull' | 'Read' | 'Write' | 'Manage';
```

Hierarchy (each level includes permissions of lower levels):
- **Pull**: Can pull/sync data
- **Read**: Can read messages and content
- **Write**: Can post messages and create content
- **Manage**: Can manage members and settings

## Error Handling

All auth functions can throw `AuthError`:

```typescript
import { AuthError } from '../ffi/deltaCore';

try {
  await addMemberDirect(orgId, memberKey, 'Read');
} catch (err) {
  if (err instanceof AuthError) {
    switch (err.kind) {
      case 'Unauthorized':
        Alert.alert('Permission Denied', 'You need Manage access');
        break;
      case 'InvalidSignature':
        Alert.alert('Invalid Token', 'Token signature verification failed');
        break;
      case 'TokenExpired':
        Alert.alert('Expired', 'This invite has expired');
        break;
      case 'NotInitialised':
        Alert.alert('Error', 'Core not initialized');
        break;
    }
  }
}
```

## NFC Workflow

### Writing Invite to NFC Tag
1. User generates invite token
2. User taps "Write NFC" button
3. App requests NFC technology
4. User holds phone near blank NFC tag
5. App writes NDEF text record: `delta-invite:<token>`
6. Success confirmation shown

### Reading Invite from NFC Tag
1. User taps "NFC Tap" in Add Member screen
2. App requests NFC technology
3. User holds phone near NFC tag
4. App reads NDEF text record
5. App extracts token from `delta-invite:<token>` format
6. App verifies token signature and expiry
7. App shows confirmation dialog
8. User confirms to add member

## QR Code Workflow

### Generating QR Code
1. User generates invite token
2. App displays QR code containing token
3. User can share via system share sheet

### Scanning QR Code (Coming Soon)
1. User taps "QR Code" in Add Member screen
2. App opens camera
3. User scans QR code
4. App extracts token
5. App verifies and adds member

## Testing on Physical Devices

### iOS
- Requires iPhone 7 or later
- Enable NFC in Settings → General → NFC
- Use NTAG213/215/216 tags for best compatibility

### Android
- Enable NFC in Settings → Connected devices → Connection preferences → NFC
- Most Android 4.4+ devices support NFC
- Use NDEF-formatted tags

## Troubleshooting

### "NFC not supported"
- Device doesn't have NFC hardware
- Use QR codes as alternative

### "Permission denied" errors
- User doesn't have Manage access
- Only Manage-level members can add/remove members

### "Token expired"
- Generate a new token with longer expiry
- Default is 24 hours

### NFC read/write failures
- Ensure tag is NDEF-formatted
- Hold phone steady near tag
- Try different tag type

## Next Steps

1. Implement QR code scanning (camera integration)
2. Add manual public key entry with validation
3. Create member profile screens
4. Add member search/filter
5. Implement batch operations
6. Add member activity logs
