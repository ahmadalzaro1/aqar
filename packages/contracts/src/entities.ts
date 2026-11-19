import { z } from 'zod';

export const unitStatusSchema = z.enum(['vacant', 'occupied', 'turnover', 'unavailable']);
export type UnitStatus = z.infer<typeof unitStatusSchema>;

export const leaseStatusSchema = z.enum(['upcoming', 'active', 'ended', 'cancelled']);
export type LeaseStatus = z.infer<typeof leaseStatusSchema>;

export const roleSchema = z.enum([
  'owner_admin', 'property_manager', 'maintenance_coordinator', 'accountant',
  'leasing_agent', 'vendor', 'tenant', 'owner', 'agent',
]);
export type Role = z.infer<typeof roleSchema>;

export const meterKindSchema = z.enum(['water', 'electric', 'generator']);
export type MeterKind = z.infer<typeof meterKindSchema>;

export const ticketStatusSchema = z.enum([
  'new', 'triaged', 'awaiting_tenant', 'approved', 'dispatched',
  'in_progress', 'completed', 'closed', 'cancelled',
]);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

export const applicationStatusSchema = z.enum([
  'received', 'screening', 'documents_pending', 'ready_for_decision', 'approved', 'rejected', 'withdrawn',
]);
export type ApplicationStatus = z.infer<typeof applicationStatusSchema>;

export const localeSchema = z.enum(['ar', 'en']);
export type Locale = z.infer<typeof localeSchema>;

/** Jordanian addressing: district + building + floor + unit, not US street/ZIP. */
export const addressSchema = z.object({
  district: z.string().min(1),
  buildingName: z.string().nullable(),
  street: z.string().nullable(),
  floor: z.string().nullable(),
  unitLabel: z.string().nullable(),
  city: z.string().min(1),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
});
export type Address = z.infer<typeof addressSchema>;
