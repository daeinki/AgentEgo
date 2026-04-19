import { Type, type Static } from '@sinclair/typebox';

export const ChannelType = Type.Union([
  Type.Literal('whatsapp'),
  Type.Literal('telegram'),
  Type.Literal('slack'),
  Type.Literal('discord'),
  Type.Literal('webchat'),
  Type.Literal('signal'),
]);
export type ChannelType = Static<typeof ChannelType>;

export const TextContent = Type.Object({
  type: Type.Literal('text'),
  text: Type.String(),
});

export const MediaContent = Type.Object({
  type: Type.Literal('media'),
  mimeType: Type.String(),
  url: Type.String(),
  caption: Type.Optional(Type.String()),
});

export const ReactionContent = Type.Object({
  type: Type.Literal('reaction'),
  emoji: Type.String(),
  targetMessageId: Type.String(),
});

export const CommandContent = Type.Object({
  type: Type.Literal('command'),
  name: Type.String(),
  args: Type.Array(Type.String()),
});

export const MessageContent = Type.Union([
  TextContent,
  MediaContent,
  ReactionContent,
  CommandContent,
]);
export type MessageContent = Static<typeof MessageContent>;

export const StandardMessage = Type.Object({
  id: Type.String(),
  traceId: Type.String(),
  timestamp: Type.Number(),
  channel: Type.Object({
    type: ChannelType,
    id: Type.String(),
    metadata: Type.Record(Type.String(), Type.Unknown()),
  }),
  sender: Type.Object({
    id: Type.String(),
    displayName: Type.Optional(Type.String()),
    isOwner: Type.Boolean(),
  }),
  conversation: Type.Object({
    type: Type.Union([Type.Literal('dm'), Type.Literal('group')]),
    id: Type.String(),
    title: Type.Optional(Type.String()),
  }),
  content: MessageContent,
  replyTo: Type.Optional(Type.String()),
});
export type StandardMessage = Static<typeof StandardMessage>;

export const OutboundContent = Type.Union([
  Type.Object({ type: Type.Literal('text'), text: Type.String() }),
  Type.Object({
    type: Type.Literal('media'),
    mimeType: Type.String(),
    url: Type.String(),
    caption: Type.Optional(Type.String()),
  }),
]);
export type OutboundContent = Static<typeof OutboundContent>;
