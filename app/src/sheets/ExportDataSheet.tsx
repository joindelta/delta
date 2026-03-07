import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  Share,
} from 'react-native';
import ActionSheet, { SheetManager, SheetProps } from 'react-native-actions-sheet';
import { X, Download, FileText, Users, MessageSquare, Database } from 'lucide-react-native';
import { useProfileStore } from '../stores/useProfileStore';
import { listMyOrgs } from '../ffi/gardensCore';

export function ExportDataSheet(props: SheetProps<'export-data-sheet'>) {
  const { myProfile } = useProfileStore();
  const [exporting, setExporting] = useState(false);
  const [includeOrgs, setIncludeOrgs] = useState(true);
  const [includeMessages, setIncludeMessages] = useState(true);
  const [includeProfile, setIncludeProfile] = useState(true);

  const handleExport = async () => {
    setExporting(true);
    try {
      // Build export data
      const exportData: any = {
        exportDate: new Date().toISOString(),
        version: '1.0',
      };

      if (includeProfile && myProfile) {
        exportData.profile = {
          username: myProfile.username,
          bio: myProfile.bio,
          availableFor: myProfile.availableFor,
          isPublic: myProfile.isPublic,
          publicKey: myProfile.publicKey,
        };
      }

      if (includeOrgs) {
        const orgs = await listMyOrgs();
        exportData.organizations = orgs.map(org => ({
          orgId: org.orgId,
          name: org.name,
          typeLabel: org.typeLabel,
          description: org.description,
          isPublic: org.isPublic,
          createdAt: org.createdAt,
        }));
      }

      if (includeMessages) {
        // In a full implementation, this would export messages
        exportData.messages = {
          note: 'Message export not yet implemented',
          count: 0,
        };
      }

      // Convert to JSON
      const jsonData = JSON.stringify(exportData, null, 2);
      
      // Share the data
      await Share.share({
        message: jsonData,
        title: 'Gardens Data Export',
      });

      SheetManager.hide('export-data-sheet');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to export data');
    } finally {
      setExporting(false);
    }
  };

  function close() {
    SheetManager.hide('export-data-sheet');
  }

  const ToggleOption = ({ 
    icon: Icon, 
    title, 
    description, 
    value, 
    onChange 
  }: { 
    icon: any; 
    title: string; 
    description: string; 
    value: boolean; 
    onChange: (v: boolean) => void;
  }) => (
    <TouchableOpacity 
      style={[s.option, value && s.optionSelected]} 
      onPress={() => onChange(!value)}
    >
      <View style={s.optionIcon}>
        <Icon size={22} color={value ? '#F2E58F' : '#666'} />
      </View>
      <View style={s.optionContent}>
        <Text style={[s.optionTitle, value && s.optionTitleSelected]}>{title}</Text>
        <Text style={s.optionDesc}>{description}</Text>
      </View>
      <View style={[s.checkbox, value && s.checkboxChecked]}>
        {value && <Text style={s.checkmark}>✓</Text>}
      </View>
    </TouchableOpacity>
  );

  return (
    <ActionSheet
      id={props.sheetId}
      gestureEnabled
      containerStyle={s.container}
      indicatorStyle={s.handle}
    >
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={close} style={s.headerBtn}>
          <X size={20} color="#888" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Export Data</Text>
        <View style={s.headerSpacer} />
      </View>

      <ScrollView style={s.content} showsVerticalScrollIndicator={false}>
        <Text style={s.description}>
          Export your data in a portable format. You can choose what to include in the export.
        </Text>

        {/* Options */}
        <View style={s.optionsSection}>
          <ToggleOption
            icon={FileText}
            title="Profile"
            description="Your display name, bio, and preferences"
            value={includeProfile}
            onChange={setIncludeProfile}
          />
          <ToggleOption
            icon={Users}
            title="Organizations"
            description="Communities you're a member of"
            value={includeOrgs}
            onChange={setIncludeOrgs}
          />
          <ToggleOption
            icon={MessageSquare}
            title="Messages"
            description="Your chat history and DMs"
            value={includeMessages}
            onChange={setIncludeMessages}
          />
        </View>

        {/* Info box */}
        <View style={s.infoBox}>
          <Database size={18} color="#3b82f6" />
          <Text style={s.infoText}>
            Your data will be exported as a JSON file. Keep it secure as it contains your personal information.
          </Text>
        </View>

        {/* Export button */}
        <TouchableOpacity 
          style={[s.exportBtn, exporting && s.exportBtnDisabled]} 
          onPress={handleExport}
          disabled={exporting || (!includeProfile && !includeOrgs && !includeMessages)}
        >
          {exporting ? (
            <ActivityIndicator color="#000" />
          ) : (
            <>
              <Download size={18} color="#000" />
              <Text style={s.exportBtnText}>Export Data</Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </ActionSheet>
  );
}

const s = StyleSheet.create({
  container: { 
    backgroundColor: '#111', 
    paddingHorizontal: 20, 
    paddingBottom: 40,
    minHeight: 500,
  },
  handle: { backgroundColor: '#333' },
  center: { paddingVertical: 40, alignItems: 'center' },
  
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  headerBtn: { padding: 4 },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  headerSpacer: { width: 28 },
  
  content: { marginTop: 16 },
  
  description: {
    color: '#888',
    fontSize: 14,
    marginBottom: 20,
    lineHeight: 20,
  },
  
  optionsSection: {
    gap: 12,
    marginBottom: 20,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#333',
  },
  optionSelected: {
    borderColor: '#F2E58F',
    backgroundColor: '#052e16',
  },
  optionIcon: {
    width: 40,
    alignItems: 'center',
  },
  optionContent: {
    flex: 1,
  },
  optionTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '500',
  },
  optionTitleSelected: {
    color: '#F2E58F',
  },
  optionDesc: {
    color: '#666',
    fontSize: 12,
    marginTop: 2,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#555',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: '#F2E58F',
    borderColor: '#F2E58F',
  },
  checkmark: {
    color: '#000',
    fontSize: 12,
    fontWeight: '700',
  },
  
  infoBox: {
    flexDirection: 'row',
    backgroundColor: '#1e3a5f',
    borderRadius: 12,
    padding: 14,
    gap: 12,
    marginBottom: 20,
  },
  infoText: {
    flex: 1,
    color: '#93c5fd',
    fontSize: 13,
    lineHeight: 18,
  },
  
  exportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#F2E58F',
    paddingVertical: 16,
    borderRadius: 12,
  },
  exportBtnDisabled: {
    opacity: 0.5,
  },
  exportBtnText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '600',
  },
});
