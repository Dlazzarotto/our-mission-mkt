export const CHANNELS = [
  "instagram",
  "facebook",
  "google_business",
  "linkedin",
  "email",
  "whatsapp",
] as const;

export const CONTENT_FORMATS = [
  "photo",
  "carousel",
  "reel",
  "story",
  "video",
  "email",
] as const;

export const CONTENT_STATUSES = [
  "planned",
  "generating",
  "review",
  "approved",
  "scheduled",
  "published",
  "rejected",
] as const;

export const VISUAL_STYLES = [
  "classic",
  "current",
  "minimal",
  "editorial",
  "vibrant",
  "premium",
  "organic",
  "custom",
] as const;

export const CONTENT_OBJECTIVES = [
  "attract",
  "educate",
  "social_proof",
  "convert",
  "retain",
  "engage",
] as const;

export type Channel = (typeof CHANNELS)[number];
export type ContentFormat = (typeof CONTENT_FORMATS)[number];
export type ContentStatus = (typeof CONTENT_STATUSES)[number];
export type VisualStyle = (typeof VISUAL_STYLES)[number];
export type ContentObjective = (typeof CONTENT_OBJECTIVES)[number];

export type BrandPalette = {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
};

export type BrandKit = {
  id: string;
  clientId: string;
  palette: BrandPalette;
  visualStyle: VisualStyle;
  toneOfVoice: string;
  requiredTerms: string[];
  forbiddenTerms: string[];
  preferredCta: string;
  imageReferences: string[];
  logoUrl?: string;
};

export type DeliveryRule = {
  id: string;
  channel: Channel;
  format: ContentFormat;
  quantity: number;
  period: "week" | "month";
  objective?: ContentObjective;
};

export type SpecialDateRule = {
  id: string;
  eventKey: string;
  label: string;
  eventDate: string;
  quantity: number;
  format: ContentFormat;
  isExtra: boolean;
  enabled: boolean;
};

export type ClientContract = {
  id: string;
  clientId: string;
  name: string;
  status: "active" | "paused" | "ended";
  startsAt: string;
  endsAt?: string;
  market: "US" | "BR" | "OTHER";
  timezone: string;
  generationCadence: "weekly" | "monthly";
  nextGenerationAt: string;
  approvalRequired: boolean;
  deliveryRules: DeliveryRule[];
  specialDateRules: SpecialDateRule[];
};

export type Client = {
  id: string;
  organizationId: string;
  companyName: string;
  industry: string;
  service: string;
  region: string;
  contactName: string;
  contactEmail: string;
  instagram?: string;
  website?: string;
  marketingMaturity: string;
  differentiators: string[];
  active: boolean;
  brandKit: BrandKit;
  contract: ClientContract;
};

export type Campaign = {
  id: string;
  clientId: string;
  contractId: string;
  name: string;
  goal: string;
  startsAt: string;
  endsAt: string;
  status: "draft" | "in_review" | "approved" | "active" | "completed";
  createdAt: string;
};

export type ContentItem = {
  id: string;
  campaignId: string;
  clientId: string;
  title: string;
  scheduledAt: string;
  channel: Channel;
  format: ContentFormat;
  objective: ContentObjective;
  pillar: string;
  status: ContentStatus;
  caption: string;
  hashtags: string[];
  creativeBrief: string;
  imagePrompt?: string;
  videoScript?: string;
  generatedByAi: boolean;
  approvalNotes?: string;
};

export type GenerationJob = {
  id: string;
  clientId: string;
  campaignId?: string;
  type: "campaign_plan" | "content_batch" | "rewrite";
  status: "queued" | "processing" | "completed" | "failed";
  scheduledFor: string;
  attempts: number;
  maxAttempts: number;
  error?: string;
};

export type AiCampaignDraft = {
  campaignName: string;
  campaignGoal: string;
  summary: string;
  contentItems: Array<
    Pick<
      ContentItem,
      | "title"
      | "scheduledAt"
      | "channel"
      | "format"
      | "objective"
      | "pillar"
      | "caption"
      | "hashtags"
      | "creativeBrief"
      | "imagePrompt"
      | "videoScript"
    >
  >;
};

export const channelLabels: Record<Channel, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  google_business: "Google Business",
  linkedin: "LinkedIn",
  email: "E-mail",
  whatsapp: "WhatsApp",
};

export const formatLabels: Record<ContentFormat, string> = {
  photo: "Foto / arte",
  carousel: "Carrossel",
  reel: "Reel",
  story: "Story",
  video: "Vídeo",
  email: "E-mail",
};

export const objectiveLabels: Record<ContentObjective, string> = {
  attract: "Atrair",
  educate: "Educar",
  social_proof: "Prova social",
  convert: "Converter",
  retain: "Reter",
  engage: "Engajar",
};

export const visualStyleLabels: Record<VisualStyle, string> = {
  classic: "Clássico",
  current: "Atual",
  minimal: "Minimalista",
  editorial: "Editorial",
  vibrant: "Vibrante",
  premium: "Premium",
  organic: "Orgânico",
  custom: "Personalizado",
};

export const statusLabels: Record<ContentStatus, string> = {
  planned: "Planejado",
  generating: "Gerando",
  review: "Em revisão",
  approved: "Aprovado",
  scheduled: "Agendado",
  published: "Publicado",
  rejected: "Reprovado",
};
