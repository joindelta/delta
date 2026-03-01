# NFC Setup Guide

## iOS Configuration

### 1. Add NFC Capability
Edit `ios/DeltaApp/DeltaApp.entitlements`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.developer.nfc.readersession.formats</key>
    <array>
        <string>NDEF</string>
    </array>
</dict>
</plist>
```

### 2. Update Info.plist
Add to `ios/DeltaApp/Info.plist`:
```xml
<key>NFCReaderUsageDescription</key>
<string>Delta needs NFC access to read invite tags</string>
```

### 3. Enable in Xcode
1. Open `ios/DeltaApp.xcworkspace` in Xcode
2. Select DeltaApp target
3. Go to "Signing & Capabilities"
4. Click "+ Capability"
5. Add "Near Field Communication Tag Reading"

## Android Configuration

### 1. Add Permissions
Edit `android/app/src/main/AndroidManifest.xml`:
```xml
<manifest>
    <!-- Add these permissions -->
    <uses-permission android:name="android.permission.NFC" />
    <uses-feature android:name="android.hardware.nfc" android:required="false" />
    
    <application>
        <!-- Add NFC intent filter to MainActivity -->
        <activity android:name=".MainActivity">
            <intent-filter>
                <action android:name="android.nfc.action.NDEF_DISCOVERED"/>
                <category android:name="android.intent.category.DEFAULT"/>
            </intent-filter>
        </activity>
    </application>
</manifest>
```

### 2. Gradle Configuration
No additional gradle changes needed - `react-native-nfc-manager` handles this automatically.

## Testing NFC

### iOS
- Requires iPhone 7 or later
- NFC only works on physical devices (not simulator)
- Test with NDEF-formatted NFC tags (Type 2, Type 4, or Type 5)

### Android
- Requires NFC-enabled device
- Works on most Android devices from 4.4+
- Test with NDEF-formatted NFC tags

## NFC Tag Recommendations

### Compatible Tags
- **NTAG213/215/216**: Best for general use, 144-888 bytes
- **MIFARE Ultralight**: Cheap, 64 bytes
- **MIFARE Classic**: Common, 1KB
- **Type 4 Tags**: ISO 14443-4 compliant

### Tag Format
Tags must be formatted as NDEF (NFC Data Exchange Format) with a text record.

### Writing Tags
Use the Invite screen's "Write NFC" button to write invite tokens to blank tags.

## Troubleshooting

### iOS Issues
- **"NFC not supported"**: Device doesn't have NFC hardware
- **"Session timeout"**: User took too long to scan - try again
- **"Tag not NDEF formatted"**: Use a different tag or format it first

### Android Issues
- **"NFC disabled"**: User needs to enable NFC in system settings
- **"Tag read error"**: Tag may be damaged or incompatible
- **"Write failed"**: Tag may be read-only or locked

## Security Notes

1. **Token Expiry**: Always set reasonable expiry times (default: 24 hours)
2. **Access Levels**: Use minimum required access level for invites
3. **Token Rotation**: Generate new tokens regularly
4. **Physical Security**: NFC tags can be copied - treat them like passwords
5. **Signature Verification**: All tokens are Ed25519 signed and verified

## Alternative: QR Codes

If NFC is not available, use QR codes instead:
- More universally supported
- Works on all devices with cameras
- Can be shared digitally (screenshots, messages)
- Less convenient for in-person transfers
