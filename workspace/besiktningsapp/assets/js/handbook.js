/**
 * handbook.js — Besiktningsappen
 * Renders handbook sections, TOC, search, terms
 * Works without handbook.json (graceful fallback)
 */

'use strict';

const HandbookModule = (() => {

  let _data = null;
  let _searchTimeout = null;
  let _activeSectionId = null;

  // Color coding per book section
  const SECTION_META = {
    'om-handboken':     { icon: '📖', color: 'blue',   label: 'Blå delen' },
    'handbokens-delar': { icon: '📑', color: 'green',  label: 'Översikt' },
    'besiktningstyper': { icon: '🔍', color: 'blue',   label: 'Blå delen' },
    'process':          { icon: '📋', color: 'blue',   label: 'Blå delen' },
    'fackmasigt':       { icon: '📐', color: 'yellow', label: 'Gula delen' },
    'terms':            { icon: '📚', color: 'red',    label: 'Röda delen' },
  };

  function _getMeta(sectionId, dataColor) {
    const base = SECTION_META[sectionId] || { icon: '📄', color: 'blue', label: '' };
    if (dataColor) return { ...base, color: dataColor };
    return base;
  }

  // ============================================================
  // Public API
  // ============================================================
  function setData(data, termsData) {
    if (termsData && termsData.terms) {
      data.terms = termsData.terms;
    }
    _data = data;
    // If current view is already visible, render now
    if (document.getElementById('view-handbook').classList.contains('active')) {
      render(data);
    }
  }

  function render(data) {
    const loading = document.getElementById('handbook-loading');
    const sections = document.getElementById('handbook-sections');
    const error = document.getElementById('handbook-error');

    if (!data) {
      if (loading) loading.style.display = 'none';
      if (error) error.style.display = 'flex';
      return;
    }

    if (loading) loading.style.display = 'none';
    if (error) error.style.display = 'none';

    _renderTOC(data.sections || []);
    _renderSections(data.sections || []);
    _renderTerms(data.terms || []);

    if (sections) sections.style.display = '';
  }

  // ============================================================
  // Table of contents
  // ============================================================
  function _renderTOC(sections) {
    const nav = document.getElementById('toc-nav');
    if (!nav) return;

    nav.innerHTML = '';

    if (!sections.length) {
      nav.innerHTML = '<div class="toc-loading">Inga sektioner hittade.</div>';
      return;
    }

    sections.forEach(sec => {
      const meta = _getMeta(sec.id, sec.color);
      const group = document.createElement('div');
      group.className = 'toc-group';
      group.dataset.bookColor = meta.color;

      const btn = document.createElement('button');
      btn.className = 'toc-item toc-parent';
      btn.dataset.sectionId = sec.id;

      const hasChildren = sec.subsections && sec.subsections.length > 0;

      btn.innerHTML = `${hasChildren ? '<span class="toc-arrow">›</span>' : ''}<span class="toc-icon">${meta.icon}</span><span class="toc-item-text">${_escHtml(sec.title || sec.id)}</span>`;

      btn.addEventListener('click', () => {
        if (hasChildren) {
          group.classList.toggle('expanded');
        } else {
          _scrollToSection(sec.id);
          _setActiveTOCItem(sec.id);
          _closeMobileTOC();
        }
      });

      group.appendChild(btn);

      if (hasChildren) {
        const subList = document.createElement('div');
        subList.className = 'toc-children';

        sec.subsections.forEach(sub => {
          const subBtn = document.createElement('button');
          subBtn.className = 'toc-item toc-child';
          subBtn.dataset.sectionId = sec.id + '-' + sub.id;
          subBtn.dataset.parentId = sec.id;
          subBtn.textContent = sub.title || sub.id;
          subBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _closeMobileTOC();
            _expandSection(sec.id);
            setTimeout(() => {
              const el = document.getElementById('subsection-' + sec.id + '-' + sub.id);
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 50);
            _setActiveTOCItem(sec.id + '-' + sub.id);
          });
          subList.appendChild(subBtn);
        });

        group.appendChild(subList);
      }

      nav.appendChild(group);
    });
  }

  function _setActiveTOCItem(sectionId) {
    document.querySelectorAll('.toc-item').forEach(item => {
      item.classList.toggle('active', item.dataset.sectionId === sectionId);
    });
    _activeSectionId = sectionId;
    // Fix #12: scroll active TOC item into view in sidebar
    const activeItem = document.querySelector('.toc-item.active');
    if (activeItem) activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function _scrollToSection(sectionId) {
    const el = document.getElementById('section-' + sectionId);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    _expandSection(sectionId);
  }

  // ============================================================
  // Sections rendering
  // ============================================================
  function _renderSections(sections) {
    const container = document.getElementById('handbook-sections');
    if (!container) return;

    container.innerHTML = '';

    if (!sections.length) {
      container.innerHTML = '<p style="color:var(--color-text-muted);padding:var(--space-lg)">Inga sektioner hittades i handbook.json.</p>';
      return;
    }

    sections.forEach(sec => {
      const sectionEl = _buildSection(sec);
      container.appendChild(sectionEl);
    });

    // Set up intersection observer for TOC highlighting
    _initIntersectionObserver();
  }

  function _buildSection(sec) {
    const meta = _getMeta(sec.id, sec.color);
    const article = document.createElement('article');
    article.className = 'handbook-section';
    article.id = 'section-' + sec.id;
    article.dataset.bookColor = meta.color;

    // Section header
    const header = document.createElement('div');
    header.className = 'section-header';
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', 'true');

    header.innerHTML = `
      <h2 class="section-title"><span class="section-icon">${meta.icon}</span> ${_escHtml(sec.title || sec.id)}</h2>
      <span class="section-toggle" aria-hidden="true">▼</span>
    `;

    header.addEventListener('click', () => _toggleSection(sec.id, header));
    header.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        _toggleSection(sec.id, header);
      }
    });

    article.appendChild(header);

    // Section content
    const content = document.createElement('div');
    content.className = 'section-content';
    content.id = 'section-content-' + sec.id;

    // Introduction text
    const introText = sec.intro || sec.content || '';
    if (introText) {
      const intro = document.createElement('div');
      intro.className = 'subsection-text';
      intro.style.padding = 'var(--space-sm) 0 var(--space-md)';
      intro.innerHTML = _processText(introText);
      content.appendChild(intro);
    }

    // Subsections
    if (sec.subsections && sec.subsections.length) {
      sec.subsections.forEach(sub => {
        content.appendChild(_buildSubsection(sub, sec.id));
      });
    }

    // Tolerances at section level
    if (sec.tolerances && sec.tolerances.length) {
      content.appendChild(_buildToleranceBox(sec.tolerances, sec.title));
    }

    article.appendChild(content);
    return article;
  }

  function _buildSubsection(sub, parentId) {
    const div = document.createElement('div');
    div.className = 'subsection';
    div.id = 'subsection-' + parentId + '-' + sub.id;
    if (sub.color) {
      div.dataset.bookColor = sub.color;
    }

    let html = '';

    if (sub.title) {
      html += `<h3 class="subsection-title">${_escHtml(sub.title)}</h3>`;
    }

    const subText = sub.text || sub.content || '';
    if (subText) {
      html += `<div class="subsection-text">${_processText(subText)}</div>`;
    }

    div.innerHTML = html;

    // Tolerances for this subsection
    if (sub.tolerances && sub.tolerances.length) {
      div.appendChild(_buildToleranceBox(sub.tolerances, sub.title));
    }

    return div;
  }

  function _buildToleranceBox(tolerances, label) {
    const box = document.createElement('div');
    box.className = 'tolerance-box';

    let html = `<div class="tolerance-box-title">📏 Toleransvärden${label ? ': ' + _escHtml(label) : ''}</div>`;

    if (Array.isArray(tolerances) && tolerances.length) {
      // Check if we have objects with properties or simple strings
      if (typeof tolerances[0] === 'object') {
        html += `<table class="tolerance-table">
          <thead>
            <tr>
              ${Object.keys(tolerances[0]).map(k => `<th>${_escHtml(k)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${tolerances.map(row =>
              `<tr>${Object.values(row).map(v => `<td>${_escHtml(String(v))}</td>`).join('')}</tr>`
            ).join('')}
          </tbody>
        </table>`;
      } else {
        html += `<ul style="padding-left:1.2em">`;
        tolerances.forEach(t => {
          html += `<li style="font-size:var(--font-size-sm);margin-bottom:4px">${_escHtml(t)}</li>`;
        });
        html += `</ul>`;
      }
    }

    box.innerHTML = html;
    return box;
  }

  // ============================================================
  // Terms (Byggtermer)
  // ============================================================
  function _renderTerms(terms) {
    if (!terms || !terms.length) return;

    const container = document.getElementById('handbook-sections');
    if (!container) return;

    const meta = _getMeta('terms');
    const article = document.createElement('article');
    article.className = 'handbook-section';
    article.id = 'section-terms';
    article.dataset.bookColor = meta.color;

    const header = document.createElement('div');
    header.className = 'section-header';
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.innerHTML = `
      <h2 class="section-title"><span class="section-icon">${meta.icon}</span> Byggtermer & ordlista</h2>
      <span class="section-toggle" aria-hidden="true">▼</span>
    `;
    header.addEventListener('click', () => _toggleSection('terms', header));

    article.appendChild(header);

    const content = document.createElement('div');
    content.className = 'section-content';
    content.id = 'section-content-terms';

    const searchBox = document.createElement('div');
    searchBox.style.marginBottom = 'var(--space-md)';
    searchBox.innerHTML = `
      <div class="search-container">
        <input type="search" id="terms-search" class="search-input"
          placeholder="Sök bland byggtermer..." aria-label="Sök byggtermer">
        <span class="search-icon">🔍</span>
      </div>`;
    content.appendChild(searchBox);

    const termsContainer = document.createElement('div');
    termsContainer.id = 'terms-list';
    _renderTermsList(terms, termsContainer);
    content.appendChild(termsContainer);

    article.appendChild(content);
    container.appendChild(article);

    // TOC item for terms
    const nav = document.getElementById('toc-nav');
    if (nav) {
      const termsGroup = document.createElement('div');
      termsGroup.className = 'toc-group';
      termsGroup.dataset.bookColor = 'red';
      const btn = document.createElement('button');
      btn.className = 'toc-item toc-parent';
      btn.dataset.sectionId = 'terms';
      btn.innerHTML = '<span class="toc-icon">📚</span><span class="toc-item-text">Byggtermer</span>';
      btn.addEventListener('click', () => {
        _scrollToSection('terms');
        _setActiveTOCItem('terms');
        _closeMobileTOC();
      });
      termsGroup.appendChild(btn);
      nav.appendChild(termsGroup);
    }

    // Search terms
    const termsSearch = document.getElementById('terms-search');
    if (termsSearch) {
      termsSearch.addEventListener('input', (e) => {
        _filterTerms(terms, e.target.value, termsContainer);
      });
    }
  }

  function _renderTermsList(terms, container) {
    container.innerHTML = '';
    terms.forEach(term => {
      const card = document.createElement('div');
      card.className = 'term-card';
      card.setAttribute('role', 'article');
      card.innerHTML = `
        <div class="term-name">${_escHtml(term.term || term.name || '')}</div>
        <div class="term-def">${_escHtml(term.definition || term.def || '')}</div>
      `;
      container.appendChild(card);
    });
  }

  function _filterTerms(terms, query, container) {
    const q = query.trim().toLowerCase();
    if (!q) {
      _renderTermsList(terms, container);
      return;
    }
    const filtered = terms.filter(t => {
      const name = (t.term || t.name || '').toLowerCase();
      const def = (t.definition || t.def || '').toLowerCase();
      return name.includes(q) || def.includes(q);
    });
    _renderTermsList(filtered, container);
    if (!filtered.length) {
      container.innerHTML = `<p style="color:var(--color-text-muted);font-size:var(--font-size-sm)">Inga träffar för "${_escHtml(query)}".</p>`;
    }
  }

  // ============================================================
  // Toggle sections
  // ============================================================
  function _toggleSection(sectionId, headerEl) {
    const content = document.getElementById('section-content-' + sectionId);
    if (!content) return;

    const isCollapsed = headerEl.classList.contains('collapsed');

    if (isCollapsed) {
      _expandSection(sectionId);
    } else {
      content.classList.add('collapsed');
      headerEl.classList.add('collapsed');
      headerEl.setAttribute('aria-expanded', 'false');
    }
  }

  function _expandSection(sectionId) {
    const content = document.getElementById('section-content-' + sectionId);
    const header = document.querySelector(`.section-header[onclick]`) || null;
    if (content) content.classList.remove('collapsed');
    const h = document.querySelector('#section-' + sectionId + ' .section-header');
    if (h) {
      h.classList.remove('collapsed');
      h.setAttribute('aria-expanded', 'true');
    }
  }

  // ============================================================
  // Search
  // ============================================================
  function initSearch() {
    const input = document.getElementById('handbook-search');
    if (!input) return;

    input.addEventListener('input', (e) => {
      clearTimeout(_searchTimeout);
      _searchTimeout = setTimeout(() => {
        _performSearch(e.target.value.trim());
      }, 250);
    });
  }

  function _performSearch(query) {
    const sections = document.getElementById('handbook-sections');
    const results = document.getElementById('handbook-search-results');
    if (!sections || !results) return;

    if (!query) {
      results.style.display = 'none';
      sections.style.display = '';
      return;
    }

    if (!_data) {
      results.innerHTML = '<p>Handboken är inte laddad ännu.</p>';
      results.style.display = '';
      sections.style.display = 'none';
      return;
    }

    sections.style.display = 'none';
    results.style.display = '';

    const matches = _searchInData(query, _data);

    if (!matches.length) {
      results.innerHTML = `<div class="empty-state">
        <p class="empty-icon">🔍</p>
        <h2>Inga träffar</h2>
        <p>Inget hittades för "${_escHtml(query)}".</p>
      </div>`;
      return;
    }

    const header = document.createElement('h3');
    header.style.cssText = 'font-size:var(--font-size-sm);color:var(--color-text-muted);margin-bottom:var(--space-md)';
    header.textContent = `${matches.length} träff${matches.length !== 1 ? 'ar' : ''} för "${query}"`;

    results.innerHTML = '';
    results.appendChild(header);

    matches.forEach(match => {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.innerHTML = `
        <div class="search-result-section">${_escHtml(match.sectionTitle)}</div>
        <div class="search-result-text">${_highlightQuery(match.text, query)}</div>
      `;
      item.addEventListener('click', () => {
        results.style.display = 'none';
        sections.style.display = '';
        document.getElementById('handbook-search').value = '';
        setTimeout(() => {
          _scrollToSection(match.sectionId);
          _highlightInContent(query);
        }, 100);
      });
      results.appendChild(item);
    });
  }

  function _searchInData(query, data) {
    const q = query.toLowerCase();
    const matches = [];

    const searchText = (text, sectionId, sectionTitle) => {
      if (!text) return;
      const lower = text.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx !== -1) {
        const start = Math.max(0, idx - 60);
        const end = Math.min(text.length, idx + query.length + 60);
        matches.push({
          sectionId,
          sectionTitle,
          text: (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : ''),
        });
      }
    };

    (data.sections || []).forEach(sec => {
      searchText(sec.intro, sec.id, sec.title);
      (sec.subsections || []).forEach(sub => {
        searchText(sub.text || sub.content, sec.id, sec.title + (sub.title ? ' › ' + sub.title : ''));
        searchText(sub.title, sec.id, sec.title);
      });
    });

    (data.terms || []).forEach(term => {
      const combined = (term.term || term.name || '') + ' ' + (term.definition || term.def || '');
      searchText(combined, 'terms', '📚 Byggtermer');
    });

    return matches.slice(0, 30); // Limit results
  }

  // ============================================================
  // Intersection Observer for TOC highlighting
  // ============================================================
  function _initIntersectionObserver() {
    if (!('IntersectionObserver' in window)) return;

    const options = {
      root: document.getElementById('handbook-content'),
      rootMargin: '-10% 0px -60% 0px',
      threshold: 0,
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const sectionId = entry.target.id.replace('section-', '');
          _setActiveTOCItem(sectionId);
        }
      });
    }, options);

    document.querySelectorAll('.handbook-section').forEach(el => observer.observe(el));
  }

  // ============================================================
  // Helpers
  // ============================================================
  function _processText(text) {
    if (!text) return '';
    // Basic markdown-like processing: bold, linebreaks
    return _escHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');
  }

  function _highlightInContent(query) {
    // Remove old highlights
    document.querySelectorAll('.content-highlight').forEach(el => {
      const parent = el.parentNode;
      parent.replaceChild(document.createTextNode(el.textContent), el);
      parent.normalize();
    });
    document.querySelectorAll('.paragraph-highlight').forEach(el => {
      el.classList.remove('paragraph-highlight', 'paragraph-highlight-fade');
    });

    if (!query) return;

    const container = document.getElementById('handbook-sections');
    if (!container) return;

    const regex = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    let firstMatch = null;
    const highlightedParagraphs = new Set();

    textNodes.forEach(node => {
      if (!regex.test(node.textContent)) return;
      regex.lastIndex = 0;

      // Find the closest paragraph/block parent and highlight it
      const blockParent = node.parentElement.closest('p, .subsection-text, li, td');
      if (blockParent && !highlightedParagraphs.has(blockParent)) {
        blockParent.classList.add('paragraph-highlight');
        highlightedParagraphs.add(blockParent);
      }

      // Highlight individual query matches within text
      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      let m;
      while ((m = regex.exec(node.textContent)) !== null) {
        if (m.index > lastIdx) {
          frag.appendChild(document.createTextNode(node.textContent.slice(lastIdx, m.index)));
        }
        const mark = document.createElement('mark');
        mark.className = 'content-highlight';
        mark.textContent = m[1];
        frag.appendChild(mark);
        if (!firstMatch) firstMatch = mark;
        lastIdx = regex.lastIndex;
      }
      if (lastIdx < node.textContent.length) {
        frag.appendChild(document.createTextNode(node.textContent.slice(lastIdx)));
      }
      node.parentNode.replaceChild(frag, node);
    });

    // Scroll to first match
    if (firstMatch) {
      firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Auto-remove after 10 seconds
    setTimeout(() => {
      document.querySelectorAll('.paragraph-highlight').forEach(el => {
        el.classList.add('paragraph-highlight-fade');
      });
      document.querySelectorAll('.content-highlight').forEach(el => {
        el.classList.add('content-highlight-fade');
      });
      setTimeout(() => {
        document.querySelectorAll('.content-highlight').forEach(el => {
          const parent = el.parentNode;
          parent.replaceChild(document.createTextNode(el.textContent), el);
          parent.normalize();
        });
        document.querySelectorAll('.paragraph-highlight').forEach(el => {
          el.classList.remove('paragraph-highlight', 'paragraph-highlight-fade');
        });
      }, 1000);
    }, 10000);
  }

  function _highlightQuery(text, query) {
    const escaped = _escHtml(text);
    const q = _escHtml(query);
    const regex = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    return escaped.replace(regex, '<mark class="search-highlight">$1</mark>');
  }

  function _escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ============================================================
  // Init (called from app.js after DOM ready)
  // ============================================================
  function init() {
    initSearch();
    _initMobileTOC();
  }

  function _initMobileTOC() {
    const toc = document.getElementById('handbook-toc');
    const nav = document.getElementById('toc-nav');
    if (!toc || !nav) return;

    // Wrap nav in a wrapper div for collapse animation
    const wrapper = document.createElement('div');
    wrapper.className = 'toc-nav-wrapper';
    nav.parentNode.insertBefore(wrapper, nav);
    wrapper.appendChild(nav);

    // Add toggle bar
    const bar = document.createElement('div');
    bar.className = 'toc-toggle-bar';
    bar.innerHTML = '<span class="toc-toggle-label">📖 Innehållsförteckning</span><span class="toc-toggle-icon">▼</span>';
    toc.insertBefore(bar, wrapper);

    bar.addEventListener('click', () => {
      toc.classList.toggle('toc-open');
    });
  }

  function _closeMobileTOC() {
    const toc = document.getElementById('handbook-toc');
    if (toc) toc.classList.remove('toc-open');
  }

  document.addEventListener('DOMContentLoaded', init);

  return { setData, render };

})();

window.HandbookModule = HandbookModule;
