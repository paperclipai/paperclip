import json
import os

def calculate_runway():
    # Load P&L data
    pl_path = os.path.expanduser('~/.roc-workday-pl/pl-structured.json')
    with open(pl_path, 'r') as f:
        data = json.load(f)
    
    # Calculate average burn from negative months in 2026
    months = data['currentYear']['months']
    burns = [m['net_income'] for m in months if m['net_income'] < 0]
    
    if not burns:
        print('No negative income months found; runway infinite.')
        return
        
    avg_burn = abs(sum(burns) / len(burns))
    
    # The summary tab has the current balance: 232,374
    # (From parsing the 'Summary' section in latest.json)
    current_balance = 232374
    
    runway_months = current_balance / avg_burn
    
    print(f'Current balance: ${current_balance}')
    print(f'Average monthly burn: ${avg_burn}')
    print(f'Runway: {runway_months:.2f} months')
    
    if runway_months < 2:
        print('ALERT: Runway below 2-month threshold!')
    else:
        print('Runway sufficient.')

if __name__ == '__main__':
    calculate_runway()
