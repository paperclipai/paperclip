import { render, screen } from '@testing-library/react';
import App from './App';
import { describe, it, expect } from 'vitest';

describe('App', () => {
  it('renders the App component and converts markdown to html', async () => {
    render(<App />);
    
    const output = await screen.findByText('Hello, world!');
    expect(output.tagName).toBe('H1');
  });
});

