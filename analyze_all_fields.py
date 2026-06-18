import json
from collections import Counter

with open("may_contacts.json") as f:
    contacts = json.load(f)

print(f"Total May contacts: {len(contacts)}")

field_status_vals = []
field_realtor_vals = []
field_volume_vals = []
field_nmls_vals = []
field_leadtype_vals = []
field_loan_num_vals = []
field_sf_prop_vals = []

for c in contacts:
    for cf in c.get('customFields', []):
        id_ = cf.get('id')
        val = cf.get('value')
        if id_ == '7V6AtJy2pVbwBlPy5hUU': # Loan Application Status
            field_status_vals.append(val)
        elif id_ == 'pUjcr4Egf5DpAihUU9tA': # Realtor
            field_realtor_vals.append(val)
        elif id_ == '6C7ucMel2ugVnw8HBgJL': # Total Volume
            field_volume_vals.append(val)
        elif id_ == 'UkXSEfBTIqBLUt7wU9FJ': # NMLS
            field_nmls_vals.append(val)
        elif id_ == '8XW27vZaPWpYCsHUAb5W': # leadType
            field_leadtype_vals.append(val)
        elif id_ == 'GqgvnHtdHSqpqn3eG2IG': # Loan Number
            field_loan_num_vals.append(val)
        elif id_ == 'pBrSbW98iBClcG86M5fC': # SF Transaction Property Id
            field_sf_prop_vals.append(val)

print("\nLoan Application Status Counter:")
for k, v in Counter(field_status_vals).items():
    print(f"  {k}: {v}")

print("\nLeadType Counter:")
for k, v in Counter(field_leadtype_vals).items():
    print(f"  {k}: {v}")

print(f"\nContacts with Realtor values: {len(field_realtor_vals)} (Unique: {len(set(field_realtor_vals))})")
print("Top 10 Realtors:")
for k, v in Counter(field_realtor_vals).most_common(10):
    print(f"  {k}: {v}")

print(f"\nContacts with Volume values: {len(field_volume_vals)}")
print("Example Volume values:", field_volume_vals[:10])

print(f"\nContacts with SF prop ID values: {len(field_sf_prop_vals)}")
print("Example SF prop values:", field_sf_prop_vals[:10])
