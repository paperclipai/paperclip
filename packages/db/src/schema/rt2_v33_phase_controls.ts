import { pgTable, text, timestamp, uuid, integer, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { companies } from './companies.js';
import { authUsers } from './auth.js';

export const rt2_v33_phase_controls = pgTable('rt2_v33_phase_controls', {
	companyId: uuid('company_id').primaryKey().references(() => companies.id, { onDelete: 'cascade' }),
	phaseMode: text('phase_mode').default('shadow').notNull(),
	autoApplyAfterHours: integer('auto_apply_after_hours').default(24).notNull(),
	updatedByUserId: text('updated_by_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => {
	return {
		phaseModeCheck: check('rt2_v33_phase_controls_phase_mode_check', sql`${table.phaseMode} in ('shadow', 'co_pilot', 'auto')`),
		autoApplyAfterHoursCheck: check('rt2_v33_phase_controls_auto_apply_after_hours_check', sql`${table.autoApplyAfterHours} between 1 and 168`)
	};
});

export const rt2_v33_phase_controlsRelations = relations(rt2_v33_phase_controls, ({ one }) => ({
	company: one(companies, {
		fields: [rt2_v33_phase_controls.companyId],
		references: [companies.id],
	}),
	updatedByUser: one(authUsers, {
		fields: [rt2_v33_phase_controls.updatedByUserId],
		references: [authUsers.id],
	}),
}));
