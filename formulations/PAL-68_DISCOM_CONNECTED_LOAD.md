# PAL-68: Connected Load Declaration for DISCOM 3-Phase Application

## Plant Overview

| Parameter | Value |
|-----------|-------|
| Plot dimensions | 20 m × 15 m (300 sq.m / 3,230 sq.ft) |
| Building footprint | 15 m × 8 m (120 sq.m / 1,290 sq.ft) |
| Front setback | 5 m from road-facing boundary |
| Business | Paint manufacturing (water-based wall paints) |
| Supply required | 415 V ±6%, 3-phase 4-wire, 50 Hz |
| Sanctioned load requested | 50 kVA / 63 A |

## Connected Load Schedule

| S.No | Equipment | Rating | Qty | Connected Load (kW) | PF | Connected Load (kVA) | Starting Method | Starting Current (A) |
|------|-----------|--------|-----|--------------------|----|--------------------|----------------|---------------------|
| 1 | High-speed disperser | 30 HP / 22.4 kW | 1 | 22.4 | 0.85 | 26.4 | VFD soft-start (limited to 150% for 3s) | 110 (VFD limit) |
| 2 | Letdown mixer | 15 HP / 11.2 kW | 1 | 11.2 | 0.85 | 13.2 | VFD soft-start | 55 (VFD limit) |
| 3 | Exhaust fan (FLP) | 0.75 HP / 0.56 kW | 2 | 1.12 | 0.80 | 1.4 | DOL | 5 |
| 4 | Transfer pump | 3 HP / 2.2 kW | 1 | 2.2 | 0.82 | 2.7 | DOL | 20 |
| 5 | Filling machine (semi-auto) | 1 HP / 0.75 kW | 1 | 0.75 | 0.80 | 0.9 | DOL | 6 |
| 6 | Lighting + auxiliaries | 3.0 kVA | 1 | 2.7 | 0.90 | 3.0 | — | — |
| 7 | QC lab equipment | 1.5 kVA | 1 | 1.2 | 0.80 | 1.5 | — | — |
| **Total** | | | | **41.6 kW** | | **49.1 kVA** | | |

> **Note:** DISCOM typically sanctions at 125–150% of declared connected load for future expansion. 50 kVA (63A at 415V) is the minimum practical request for this plant configuration.

## Demand Calculation

| Parameter | Value | Basis |
|-----------|-------|-------|
| Total installed capacity | 41.6 kW / 49.1 kVA | Sum of all nameplate ratings |
| Maximum demand (estimated) | 38 kW / 45 kVA | Diversity factor 0.85 applied to non-simultaneous operation |
| Transformer capacity | Not required | DISCOM LV supply available at 415 V |
| Recommended incoming cable | 4C × 300 sq.mm Al XLPE (3Ph+N) + 1C × 185 sq.mm Al XLPE (E) | Voltage drop < 3% at 50 kVA over 8 m run |
| Main MCCB rating | 100 A TP, 25 kA IC | For 63 A sanctioned load + 25% headroom |
| Earthing | Plate earthing: body ≤ 1 Ω, neutral ≤ 1 Ω | IS 3043 |

## Motor Details for DISCOM

| Motor | Type | Frame | RPM | Full Load Current (A) @415V | Locked Rotor Current (A) |
|-------|------|-------|-----|---------------------------|------------------------|
| Disperser 30 HP | Squirrel cage induction, TEFC, inverter duty | 200L | 1440 | 42 A | 250 A (6× FLC, DOL) |
| Letdown mixer 15 HP | Squirrel cage induction, TEFC, inverter duty | 160L | 1440 | 21 A | 130 A (6× FLC, DOL) |

> Both motors will be started via VFDs limiting starting current to 150% of FLC. Direct-on-line values shown for DISCOM reference.

## Single-Line Load Distribution

```
DISCOM 11 kV / 415 V, 50 Hz
         │
    [DISCOM Meter + CT Unit]
         │  4C × 300 sq.mm Al XLPE + 1C × 185 sq.mm Al XLPE
         │  (through meter room → underground trench → building interior)
         │
[100 A TP MCCB, 25 kA IC]   ← Main Incomer at Distribution Panel
         │
  ┌──────┴──────┐
  │  Bus Bar    │  25 × 6 mm Cu, 415 V, 3P+N+E
  └──────┬──────┘
         │
    ┌────┼────┬────┬────┬────┐
    │    │    │    │    │    │
   [63A] [32A] [16A] [16A] [16A]
MCCB/  MCCB/  MCB   MCB   MCB
MPCB   MPCB
    │    │    │    │    │
   VFD  VFD   Fan  Fill  QC Lab
   1     2    1+2   Mach  + Light
    │    │                   
   M1    M2              
  (30HP) (15HP)          

```

## Meter Room

| Parameter | Specification |
|-----------|--------------|
| Location | East exterior wall, road-accessible |
| Internal dimensions | 1.5 m (W) × 1.2 m (D) × 2.4 m (H) |
| Construction | 230 mm brick masonry, plastered both sides |
| Door | MS sheet, lockable, 0.9 m × 2.0 m, outward opening |
| Cable entry | 100 mm × 100 mm PVC conduit from floor to main panel |
| Earthing | 2 × plate earth pits within 1 m of meter room |

## Declaration

The above connected load details are submitted as part of the DISCOM 3-phase industrial connection application. The total connected load declared is **49.1 kVA (~41.6 kW)**. We request a sanctioned load of **50 kVA (63 A)** at **415 V, 3-phase, 4-wire**.

---

*Prepared by: CTO, Paperclip Paints*
*Reference: PAL-19 equipment plan, PAL-41 DISCOM plan, PAL-49 building plan*
