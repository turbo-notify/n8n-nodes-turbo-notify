import type { INodePropertyOptions } from 'n8n-workflow';

/**
 * Every event type Turbo Notify emits (the server catalogue), by name, for the triggers and for
 * Event > Get Many. A webhook delivery and an entry of the events list have the same shape.
 */
export const EVENT_OPTIONS: INodePropertyOptions[] = [
	{
		name: 'Calendar Event Answered',
		value: 'message.calendar_responded',
		description: 'A guest answered a calendar event',
	},
	{
		name: 'Contact Created',
		value: 'contact.created',
		description: 'A contact was added to a number',
	},
	{
		name: 'Contact First Messaged',
		value: 'contact.first_messaged',
		description: 'A contact was messaged for the first time',
	},
	{
		name: 'Contact Name Changed',
		value: 'contact.name_changed',
		description: 'A contact changed their name',
	},
	{
		name: 'Contact Picture Changed',
		value: 'contact.picture_changed',
		description: 'A contact changed their profile picture',
	},
	{
		name: 'Contact Quota Exceeded',
		value: 'contact.quota.exceeded',
		description: 'A number used up its allowance of contacts for the cycle',
	},
	{
		name: 'Contact Quota Warning',
		value: 'contact.quota.warning',
		description: 'A number is close to its allowance of contacts',
	},
	{
		name: 'Group Description Changed',
		value: 'group.description_changed',
		description: 'The description of a group changed',
	},
	{ name: 'Group Joined', value: 'group.joined', description: 'A number joined a group' },
	{ name: 'Group Left', value: 'group.left', description: 'A number left a group' },
	{ name: 'Group Name Changed', value: 'group.name_changed', description: 'A group was renamed' },
	{
		name: 'Group Participants Added',
		value: 'group.participants_added',
		description: 'People were added to a group',
	},
	{
		name: 'Group Participants Demoted',
		value: 'group.participants_demoted',
		description: 'Admins lost their admin rights in a group',
	},
	{
		name: 'Group Participants Promoted',
		value: 'group.participants_promoted',
		description: 'People became admins of a group',
	},
	{
		name: 'Group Participants Removed',
		value: 'group.participants_removed',
		description: 'People were removed from a group',
	},
	{
		name: 'Group Picture Changed',
		value: 'group.picture_changed',
		description: 'The picture of a group changed',
	},
	{
		name: 'Group Settings Changed',
		value: 'group.settings_changed',
		description: 'The settings of a group changed',
	},
	{
		name: 'Media Unavailable',
		value: 'media.unavailable',
		description: 'Received media could not be saved to your storage',
	},
	{
		name: 'Message Delete Failed',
		value: 'message.delete.failed',
		description: 'A message could not be deleted',
	},
	{ name: 'Message Deleted', value: 'message.deleted', description: 'A message was deleted' },
	{
		name: 'Message Delivered',
		value: 'message.delivered',
		description: 'A message you sent reached the recipient',
	},
	{
		name: 'Message Edit Failed',
		value: 'message.edit.failed',
		description: 'A message could not be edited',
	},
	{
		name: 'Message Edited',
		value: 'message.edited',
		description: 'A message, a caption or a calendar event was edited',
	},
	{
		name: 'Message Quota Exceeded',
		value: 'message.quota.exceeded',
		description: 'A number used up its allowance of messages for the cycle',
	},
	{
		name: 'Message Quota Warning',
		value: 'message.quota.warning',
		description: 'A number is close to its allowance of messages',
	},
	{
		name: 'Message Reacted',
		value: 'message.reacted',
		description: 'A reaction was added or removed',
	},
	{
		name: 'Message Reaction Failed',
		value: 'message.react.failed',
		description: 'A reaction could not be sent',
	},
	{
		name: 'Message Read',
		value: 'message.read',
		description: 'The recipient read a message you sent',
	},
	{
		name: 'Message Received',
		value: 'message.received',
		description: 'A message arrived from a contact',
	},
	{
		name: 'Message Replied',
		value: 'message.replied',
		description: 'A reply was sent or received',
	},
	{
		name: 'Message Reply Failed',
		value: 'message.reply.failed',
		description: 'A reply could not be sent',
	},
	{
		name: 'Message Send Failed',
		value: 'message.send.failed',
		description: 'A message could not be sent',
	},
	{ name: 'Message Sent', value: 'message.sent', description: 'A message was sent to WhatsApp' },
	{
		name: 'Number Connect Failed',
		value: 'number.connect.failed',
		description: 'A number could not connect to WhatsApp',
	},
	{
		name: 'Number Connected',
		value: 'number.connected',
		description: 'A number connected to WhatsApp',
	},
	{ name: 'Number Created', value: 'number.created', description: 'An extra number was created' },
	{
		name: 'Number Disconnected',
		value: 'number.disconnected',
		description: 'A number lost its connection and did not come back in time',
	},
	{
		name: 'Number Removal Canceled',
		value: 'number.remove.canceled',
		description: 'The scheduled removal of a number was canceled',
	},
	{
		name: 'Number Removal Scheduled',
		value: 'number.remove.scheduled',
		description: 'The removal of a number was scheduled',
	},
	{ name: 'Number Removed', value: 'number.removed', description: 'An extra number was removed' },
	{
		name: 'Number Revoked',
		value: 'number.revoked',
		description: 'WhatsApp unlinked the device of a number',
	},
	{
		name: 'Storage Degraded',
		value: 'storage.degraded',
		description: 'Your storage bucket stopped answering',
	},
	{
		name: 'Storage Recovered',
		value: 'storage.recovered',
		description: 'Your storage bucket works again',
	},
];

/** What the triggers offer: every type, or any event at all (the default for a person who wants everything). */
export const ANY_EVENT = '*';
export const TRIGGER_EVENT_OPTIONS: INodePropertyOptions[] = [
	{
		name: 'Any Event',
		value: ANY_EVENT,
		description: 'Every type of event below, and any that is added later',
	},
	...EVENT_OPTIONS,
];

export const MAX_EVENT_TYPES = 20;

/**
 * The event types a person chose, as a list. An expression can give a list, or text with the types
 * separated by commas: both mean the same, and Any Event (`*`) stands for no filter at all.
 */
export function chosenEventTypes(value: unknown): string[] {
	const list = Array.isArray(value) ? value : String(value ?? '').split(',');
	const types = list.map((type) => String(type).trim()).filter((type) => type !== '');
	return types.includes(ANY_EVENT) ? [] : types;
}
