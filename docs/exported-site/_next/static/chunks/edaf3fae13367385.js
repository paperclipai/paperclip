(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,536239,t=>{"use strict";t.s(["StateDB",()=>q,"stateDiagram_default",()=>l,"stateRenderer_v3_unified_default",()=>B,"styles_default",()=>Q]);var e=t.i(707510),s=t.i(264861),i=t.i(903262),r=t.i(729432),n=t.i(96977),a=t.i(171206),o=function(){var t=(0,a.__name)(function(t,e,s,i){for(s=s||{},i=t.length;i--;s[t[i]]=e);return s},"o"),e=[1,2],s=[1,3],i=[1,4],r=[2,4],n=[1,9],o=[1,11],l=[1,16],c=[1,17],h=[1,18],d=[1,19],u=[1,33],p=[1,20],g=[1,21],y=[1,22],m=[1,23],_=[1,24],f=[1,26],S=[1,27],T=[1,28],k=[1,29],b=[1,30],E=[1,31],D=[1,32],C=[1,35],$=[1,36],x=[1,37],A=[1,38],I=[1,34],L=[1,4,5,16,17,19,21,22,24,25,26,27,28,29,33,35,37,38,41,45,48,51,52,53,54,57],v=[1,4,5,14,15,16,17,19,21,22,24,25,26,27,28,29,33,35,37,38,39,40,41,45,48,51,52,53,54,57],w=[4,5,16,17,19,21,22,24,25,26,27,28,29,33,35,37,38,41,45,48,51,52,53,54,57],O={trace:(0,a.__name)(function(){},"trace"),yy:{},symbols_:{error:2,start:3,SPACE:4,NL:5,SD:6,document:7,line:8,statement:9,classDefStatement:10,styleStatement:11,cssClassStatement:12,idStatement:13,DESCR:14,"-->":15,HIDE_EMPTY:16,scale:17,WIDTH:18,COMPOSIT_STATE:19,STRUCT_START:20,STRUCT_STOP:21,STATE_DESCR:22,AS:23,ID:24,FORK:25,JOIN:26,CHOICE:27,CONCURRENT:28,note:29,notePosition:30,NOTE_TEXT:31,direction:32,acc_title:33,acc_title_value:34,acc_descr:35,acc_descr_value:36,acc_descr_multiline_value:37,CLICK:38,STRING:39,HREF:40,classDef:41,CLASSDEF_ID:42,CLASSDEF_STYLEOPTS:43,DEFAULT:44,style:45,STYLE_IDS:46,STYLEDEF_STYLEOPTS:47,class:48,CLASSENTITY_IDS:49,STYLECLASS:50,direction_tb:51,direction_bt:52,direction_rl:53,direction_lr:54,eol:55,";":56,EDGE_STATE:57,STYLE_SEPARATOR:58,left_of:59,right_of:60,$accept:0,$end:1},terminals_:{2:"error",4:"SPACE",5:"NL",6:"SD",14:"DESCR",15:"-->",16:"HIDE_EMPTY",17:"scale",18:"WIDTH",19:"COMPOSIT_STATE",20:"STRUCT_START",21:"STRUCT_STOP",22:"STATE_DESCR",23:"AS",24:"ID",25:"FORK",26:"JOIN",27:"CHOICE",28:"CONCURRENT",29:"note",31:"NOTE_TEXT",33:"acc_title",34:"acc_title_value",35:"acc_descr",36:"acc_descr_value",37:"acc_descr_multiline_value",38:"CLICK",39:"STRING",40:"HREF",41:"classDef",42:"CLASSDEF_ID",43:"CLASSDEF_STYLEOPTS",44:"DEFAULT",45:"style",46:"STYLE_IDS",47:"STYLEDEF_STYLEOPTS",48:"class",49:"CLASSENTITY_IDS",50:"STYLECLASS",51:"direction_tb",52:"direction_bt",53:"direction_rl",54:"direction_lr",56:";",57:"EDGE_STATE",58:"STYLE_SEPARATOR",59:"left_of",60:"right_of"},productions_:[0,[3,2],[3,2],[3,2],[7,0],[7,2],[8,2],[8,1],[8,1],[9,1],[9,1],[9,1],[9,1],[9,2],[9,3],[9,4],[9,1],[9,2],[9,1],[9,4],[9,3],[9,6],[9,1],[9,1],[9,1],[9,1],[9,4],[9,4],[9,1],[9,2],[9,2],[9,1],[9,5],[9,5],[10,3],[10,3],[11,3],[12,3],[32,1],[32,1],[32,1],[32,1],[55,1],[55,1],[13,1],[13,1],[13,3],[13,3],[30,1],[30,1]],performAction:(0,a.__name)(function(t,e,s,i,r,n,a){var o=n.length-1;switch(r){case 3:return i.setRootDoc(n[o]),n[o];case 4:this.$=[];break;case 5:"nl"!=n[o]&&(n[o-1].push(n[o]),this.$=n[o-1]);break;case 6:case 7:case 12:this.$=n[o];break;case 8:this.$="nl";break;case 13:let l=n[o-1];l.description=i.trimColon(n[o]),this.$=l;break;case 14:this.$={stmt:"relation",state1:n[o-2],state2:n[o]};break;case 15:let c=i.trimColon(n[o]);this.$={stmt:"relation",state1:n[o-3],state2:n[o-1],description:c};break;case 19:this.$={stmt:"state",id:n[o-3],type:"default",description:"",doc:n[o-1]};break;case 20:var h=n[o],d=n[o-2].trim();if(n[o].match(":")){var u=n[o].split(":");h=u[0],d=[d,u[1]]}this.$={stmt:"state",id:h,type:"default",description:d};break;case 21:this.$={stmt:"state",id:n[o-3],type:"default",description:n[o-5],doc:n[o-1]};break;case 22:this.$={stmt:"state",id:n[o],type:"fork"};break;case 23:this.$={stmt:"state",id:n[o],type:"join"};break;case 24:this.$={stmt:"state",id:n[o],type:"choice"};break;case 25:this.$={stmt:"state",id:i.getDividerId(),type:"divider"};break;case 26:this.$={stmt:"state",id:n[o-1].trim(),note:{position:n[o-2].trim(),text:n[o].trim()}};break;case 29:this.$=n[o].trim(),i.setAccTitle(this.$);break;case 30:case 31:this.$=n[o].trim(),i.setAccDescription(this.$);break;case 32:this.$={stmt:"click",id:n[o-3],url:n[o-2],tooltip:n[o-1]};break;case 33:this.$={stmt:"click",id:n[o-3],url:n[o-1],tooltip:""};break;case 34:case 35:this.$={stmt:"classDef",id:n[o-1].trim(),classes:n[o].trim()};break;case 36:this.$={stmt:"style",id:n[o-1].trim(),styleClass:n[o].trim()};break;case 37:this.$={stmt:"applyClass",id:n[o-1].trim(),styleClass:n[o].trim()};break;case 38:i.setDirection("TB"),this.$={stmt:"dir",value:"TB"};break;case 39:i.setDirection("BT"),this.$={stmt:"dir",value:"BT"};break;case 40:i.setDirection("RL"),this.$={stmt:"dir",value:"RL"};break;case 41:i.setDirection("LR"),this.$={stmt:"dir",value:"LR"};break;case 44:case 45:this.$={stmt:"state",id:n[o].trim(),type:"default",description:""};break;case 46:case 47:this.$={stmt:"state",id:n[o-2].trim(),classes:[n[o].trim()],type:"default",description:""}}},"anonymous"),table:[{3:1,4:e,5:s,6:i},{1:[3]},{3:5,4:e,5:s,6:i},{3:6,4:e,5:s,6:i},t([1,4,5,16,17,19,22,24,25,26,27,28,29,33,35,37,38,41,45,48,51,52,53,54,57],r,{7:7}),{1:[2,1]},{1:[2,2]},{1:[2,3],4:n,5:o,8:8,9:10,10:12,11:13,12:14,13:15,16:l,17:c,19:h,22:d,24:u,25:p,26:g,27:y,28:m,29:_,32:25,33:f,35:S,37:T,38:k,41:b,45:E,48:D,51:C,52:$,53:x,54:A,57:I},t(L,[2,5]),{9:39,10:12,11:13,12:14,13:15,16:l,17:c,19:h,22:d,24:u,25:p,26:g,27:y,28:m,29:_,32:25,33:f,35:S,37:T,38:k,41:b,45:E,48:D,51:C,52:$,53:x,54:A,57:I},t(L,[2,7]),t(L,[2,8]),t(L,[2,9]),t(L,[2,10]),t(L,[2,11]),t(L,[2,12],{14:[1,40],15:[1,41]}),t(L,[2,16]),{18:[1,42]},t(L,[2,18],{20:[1,43]}),{23:[1,44]},t(L,[2,22]),t(L,[2,23]),t(L,[2,24]),t(L,[2,25]),{30:45,31:[1,46],59:[1,47],60:[1,48]},t(L,[2,28]),{34:[1,49]},{36:[1,50]},t(L,[2,31]),{13:51,24:u,57:I},{42:[1,52],44:[1,53]},{46:[1,54]},{49:[1,55]},t(v,[2,44],{58:[1,56]}),t(v,[2,45],{58:[1,57]}),t(L,[2,38]),t(L,[2,39]),t(L,[2,40]),t(L,[2,41]),t(L,[2,6]),t(L,[2,13]),{13:58,24:u,57:I},t(L,[2,17]),t(w,r,{7:59}),{24:[1,60]},{24:[1,61]},{23:[1,62]},{24:[2,48]},{24:[2,49]},t(L,[2,29]),t(L,[2,30]),{39:[1,63],40:[1,64]},{43:[1,65]},{43:[1,66]},{47:[1,67]},{50:[1,68]},{24:[1,69]},{24:[1,70]},t(L,[2,14],{14:[1,71]}),{4:n,5:o,8:8,9:10,10:12,11:13,12:14,13:15,16:l,17:c,19:h,21:[1,72],22:d,24:u,25:p,26:g,27:y,28:m,29:_,32:25,33:f,35:S,37:T,38:k,41:b,45:E,48:D,51:C,52:$,53:x,54:A,57:I},t(L,[2,20],{20:[1,73]}),{31:[1,74]},{24:[1,75]},{39:[1,76]},{39:[1,77]},t(L,[2,34]),t(L,[2,35]),t(L,[2,36]),t(L,[2,37]),t(v,[2,46]),t(v,[2,47]),t(L,[2,15]),t(L,[2,19]),t(w,r,{7:78}),t(L,[2,26]),t(L,[2,27]),{5:[1,79]},{5:[1,80]},{4:n,5:o,8:8,9:10,10:12,11:13,12:14,13:15,16:l,17:c,19:h,21:[1,81],22:d,24:u,25:p,26:g,27:y,28:m,29:_,32:25,33:f,35:S,37:T,38:k,41:b,45:E,48:D,51:C,52:$,53:x,54:A,57:I},t(L,[2,32]),t(L,[2,33]),t(L,[2,21])],defaultActions:{5:[2,1],6:[2,2],47:[2,48],48:[2,49]},parseError:(0,a.__name)(function(t,e){if(e.recoverable)this.trace(t);else{var s=Error(t);throw s.hash=e,s}},"parseError"),parse:(0,a.__name)(function(t){var e=this,s=[0],i=[],r=[null],n=[],o=this.table,l="",c=0,h=0,d=0,u=n.slice.call(arguments,1),p=Object.create(this.lexer),g={};for(var y in this.yy)Object.prototype.hasOwnProperty.call(this.yy,y)&&(g[y]=this.yy[y]);p.setInput(t,g),g.lexer=p,g.parser=this,void 0===p.yylloc&&(p.yylloc={});var m=p.yylloc;n.push(m);var _=p.options&&p.options.ranges;function f(){var t;return"number"!=typeof(t=i.pop()||p.lex()||1)&&(t instanceof Array&&(t=(i=t).pop()),t=e.symbols_[t]||t),t}"function"==typeof g.parseError?this.parseError=g.parseError:this.parseError=Object.getPrototypeOf(this).parseError,(0,a.__name)(function(t){s.length=s.length-2*t,r.length=r.length-t,n.length=n.length-t},"popStack"),(0,a.__name)(f,"lex");for(var S,T,k,b,E,D,C,$,x,A={};;){if(k=s[s.length-1],this.defaultActions[k]?b=this.defaultActions[k]:(null==S&&(S=f()),b=o[k]&&o[k][S]),void 0===b||!b.length||!b[0]){var I="";for(D in x=[],o[k])this.terminals_[D]&&D>2&&x.push("'"+this.terminals_[D]+"'");I=p.showPosition?"Parse error on line "+(c+1)+":\n"+p.showPosition()+"\nExpecting "+x.join(", ")+", got '"+(this.terminals_[S]||S)+"'":"Parse error on line "+(c+1)+": Unexpected "+(1==S?"end of input":"'"+(this.terminals_[S]||S)+"'"),this.parseError(I,{text:p.match,token:this.terminals_[S]||S,line:p.yylineno,loc:m,expected:x})}if(b[0]instanceof Array&&b.length>1)throw Error("Parse Error: multiple actions possible at state: "+k+", token: "+S);switch(b[0]){case 1:s.push(S),r.push(p.yytext),n.push(p.yylloc),s.push(b[1]),S=null,T?(S=T,T=null):(h=p.yyleng,l=p.yytext,c=p.yylineno,m=p.yylloc,d>0&&d--);break;case 2:if(C=this.productions_[b[1]][1],A.$=r[r.length-C],A._$={first_line:n[n.length-(C||1)].first_line,last_line:n[n.length-1].last_line,first_column:n[n.length-(C||1)].first_column,last_column:n[n.length-1].last_column},_&&(A._$.range=[n[n.length-(C||1)].range[0],n[n.length-1].range[1]]),void 0!==(E=this.performAction.apply(A,[l,h,c,g,b[1],r,n].concat(u))))return E;C&&(s=s.slice(0,-1*C*2),r=r.slice(0,-1*C),n=n.slice(0,-1*C)),s.push(this.productions_[b[1]][0]),r.push(A.$),n.push(A._$),$=o[s[s.length-2]][s[s.length-1]],s.push($);break;case 3:return!0}}return!0},"parse")};function N(){this.yy={}}return O.lexer={EOF:1,parseError:(0,a.__name)(function(t,e){if(this.yy.parser)this.yy.parser.parseError(t,e);else throw Error(t)},"parseError"),setInput:(0,a.__name)(function(t,e){return this.yy=e||this.yy||{},this._input=t,this._more=this._backtrack=this.done=!1,this.yylineno=this.yyleng=0,this.yytext=this.matched=this.match="",this.conditionStack=["INITIAL"],this.yylloc={first_line:1,first_column:0,last_line:1,last_column:0},this.options.ranges&&(this.yylloc.range=[0,0]),this.offset=0,this},"setInput"),input:(0,a.__name)(function(){var t=this._input[0];return this.yytext+=t,this.yyleng++,this.offset++,this.match+=t,this.matched+=t,t.match(/(?:\r\n?|\n).*/g)?(this.yylineno++,this.yylloc.last_line++):this.yylloc.last_column++,this.options.ranges&&this.yylloc.range[1]++,this._input=this._input.slice(1),t},"input"),unput:(0,a.__name)(function(t){var e=t.length,s=t.split(/(?:\r\n?|\n)/g);this._input=t+this._input,this.yytext=this.yytext.substr(0,this.yytext.length-e),this.offset-=e;var i=this.match.split(/(?:\r\n?|\n)/g);this.match=this.match.substr(0,this.match.length-1),this.matched=this.matched.substr(0,this.matched.length-1),s.length-1&&(this.yylineno-=s.length-1);var r=this.yylloc.range;return this.yylloc={first_line:this.yylloc.first_line,last_line:this.yylineno+1,first_column:this.yylloc.first_column,last_column:s?(s.length===i.length?this.yylloc.first_column:0)+i[i.length-s.length].length-s[0].length:this.yylloc.first_column-e},this.options.ranges&&(this.yylloc.range=[r[0],r[0]+this.yyleng-e]),this.yyleng=this.yytext.length,this},"unput"),more:(0,a.__name)(function(){return this._more=!0,this},"more"),reject:(0,a.__name)(function(){return this.options.backtrack_lexer?(this._backtrack=!0,this):this.parseError("Lexical error on line "+(this.yylineno+1)+". You can only invoke reject() in the lexer when the lexer is of the backtracking persuasion (options.backtrack_lexer = true).\n"+this.showPosition(),{text:"",token:null,line:this.yylineno})},"reject"),less:(0,a.__name)(function(t){this.unput(this.match.slice(t))},"less"),pastInput:(0,a.__name)(function(){var t=this.matched.substr(0,this.matched.length-this.match.length);return(t.length>20?"...":"")+t.substr(-20).replace(/\n/g,"")},"pastInput"),upcomingInput:(0,a.__name)(function(){var t=this.match;return t.length<20&&(t+=this._input.substr(0,20-t.length)),(t.substr(0,20)+(t.length>20?"...":"")).replace(/\n/g,"")},"upcomingInput"),showPosition:(0,a.__name)(function(){var t=this.pastInput(),e=Array(t.length+1).join("-");return t+this.upcomingInput()+"\n"+e+"^"},"showPosition"),test_match:(0,a.__name)(function(t,e){var s,i,r;if(this.options.backtrack_lexer&&(r={yylineno:this.yylineno,yylloc:{first_line:this.yylloc.first_line,last_line:this.last_line,first_column:this.yylloc.first_column,last_column:this.yylloc.last_column},yytext:this.yytext,match:this.match,matches:this.matches,matched:this.matched,yyleng:this.yyleng,offset:this.offset,_more:this._more,_input:this._input,yy:this.yy,conditionStack:this.conditionStack.slice(0),done:this.done},this.options.ranges&&(r.yylloc.range=this.yylloc.range.slice(0))),(i=t[0].match(/(?:\r\n?|\n).*/g))&&(this.yylineno+=i.length),this.yylloc={first_line:this.yylloc.last_line,last_line:this.yylineno+1,first_column:this.yylloc.last_column,last_column:i?i[i.length-1].length-i[i.length-1].match(/\r?\n?/)[0].length:this.yylloc.last_column+t[0].length},this.yytext+=t[0],this.match+=t[0],this.matches=t,this.yyleng=this.yytext.length,this.options.ranges&&(this.yylloc.range=[this.offset,this.offset+=this.yyleng]),this._more=!1,this._backtrack=!1,this._input=this._input.slice(t[0].length),this.matched+=t[0],s=this.performAction.call(this,this.yy,this,e,this.conditionStack[this.conditionStack.length-1]),this.done&&this._input&&(this.done=!1),s)return s;if(this._backtrack)for(var n in r)this[n]=r[n];return!1},"test_match"),next:(0,a.__name)(function(){if(this.done)return this.EOF;this._input||(this.done=!0),this._more||(this.yytext="",this.match="");for(var t,e,s,i,r=this._currentRules(),n=0;n<r.length;n++)if((s=this._input.match(this.rules[r[n]]))&&(!e||s[0].length>e[0].length)){if(e=s,i=n,this.options.backtrack_lexer){if(!1!==(t=this.test_match(s,r[n])))return t;if(!this._backtrack)return!1;e=!1;continue}if(!this.options.flex)break}return e?!1!==(t=this.test_match(e,r[i]))&&t:""===this._input?this.EOF:this.parseError("Lexical error on line "+(this.yylineno+1)+". Unrecognized text.\n"+this.showPosition(),{text:"",token:null,line:this.yylineno})},"next"),lex:(0,a.__name)(function(){var t=this.next();return t||this.lex()},"lex"),begin:(0,a.__name)(function(t){this.conditionStack.push(t)},"begin"),popState:(0,a.__name)(function(){return this.conditionStack.length-1>0?this.conditionStack.pop():this.conditionStack[0]},"popState"),_currentRules:(0,a.__name)(function(){return this.conditionStack.length&&this.conditionStack[this.conditionStack.length-1]?this.conditions[this.conditionStack[this.conditionStack.length-1]].rules:this.conditions.INITIAL.rules},"_currentRules"),topState:(0,a.__name)(function(t){return(t=this.conditionStack.length-1-Math.abs(t||0))>=0?this.conditionStack[t]:"INITIAL"},"topState"),pushState:(0,a.__name)(function(t){this.begin(t)},"pushState"),stateStackSize:(0,a.__name)(function(){return this.conditionStack.length},"stateStackSize"),options:{"case-insensitive":!0},performAction:(0,a.__name)(function(t,e,s,i){switch(s){case 0:return 38;case 1:return 40;case 2:return 39;case 3:return 44;case 4:case 45:return 51;case 5:case 46:return 52;case 6:case 47:return 53;case 7:case 48:return 54;case 8:case 9:case 11:case 12:case 13:case 14:case 57:case 59:case 65:break;case 10:case 80:return 5;case 15:case 35:return this.pushState("SCALE"),17;case 16:case 36:return 18;case 17:case 23:case 37:case 52:case 55:this.popState();break;case 18:return this.begin("acc_title"),33;case 19:return this.popState(),"acc_title_value";case 20:return this.begin("acc_descr"),35;case 21:return this.popState(),"acc_descr_value";case 22:this.begin("acc_descr_multiline");break;case 24:return"acc_descr_multiline_value";case 25:return this.pushState("CLASSDEF"),41;case 26:return this.popState(),this.pushState("CLASSDEFID"),"DEFAULT_CLASSDEF_ID";case 27:return this.popState(),this.pushState("CLASSDEFID"),42;case 28:return this.popState(),43;case 29:return this.pushState("CLASS"),48;case 30:return this.popState(),this.pushState("CLASS_STYLE"),49;case 31:return this.popState(),50;case 32:return this.pushState("STYLE"),45;case 33:return this.popState(),this.pushState("STYLEDEF_STYLES"),46;case 34:return this.popState(),47;case 38:this.pushState("STATE");break;case 39:case 42:return this.popState(),e.yytext=e.yytext.slice(0,-8).trim(),25;case 40:case 43:return this.popState(),e.yytext=e.yytext.slice(0,-8).trim(),26;case 41:case 44:return this.popState(),e.yytext=e.yytext.slice(0,-10).trim(),27;case 49:this.pushState("STATE_STRING");break;case 50:return this.pushState("STATE_ID"),"AS";case 51:case 67:return this.popState(),"ID";case 53:return"STATE_DESCR";case 54:return 19;case 56:return this.popState(),this.pushState("struct"),20;case 58:return this.popState(),21;case 60:return this.begin("NOTE"),29;case 61:return this.popState(),this.pushState("NOTE_ID"),59;case 62:return this.popState(),this.pushState("NOTE_ID"),60;case 63:this.popState(),this.pushState("FLOATING_NOTE");break;case 64:return this.popState(),this.pushState("FLOATING_NOTE_ID"),"AS";case 66:return"NOTE_TEXT";case 68:return this.popState(),this.pushState("NOTE_TEXT"),24;case 69:return this.popState(),e.yytext=e.yytext.substr(2).trim(),31;case 70:return this.popState(),e.yytext=e.yytext.slice(0,-8).trim(),31;case 71:case 72:return 6;case 73:return 16;case 74:return 57;case 75:return 24;case 76:return e.yytext=e.yytext.trim(),14;case 77:return 15;case 78:return 28;case 79:return 58;case 81:return"INVALID"}},"anonymous"),rules:[/^(?:click\b)/i,/^(?:href\b)/i,/^(?:"[^"]*")/i,/^(?:default\b)/i,/^(?:.*direction\s+TB[^\n]*)/i,/^(?:.*direction\s+BT[^\n]*)/i,/^(?:.*direction\s+RL[^\n]*)/i,/^(?:.*direction\s+LR[^\n]*)/i,/^(?:%%(?!\{)[^\n]*)/i,/^(?:[^\}]%%[^\n]*)/i,/^(?:[\n]+)/i,/^(?:[\s]+)/i,/^(?:((?!\n)\s)+)/i,/^(?:#[^\n]*)/i,/^(?:%[^\n]*)/i,/^(?:scale\s+)/i,/^(?:\d+)/i,/^(?:\s+width\b)/i,/^(?:accTitle\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*\{\s*)/i,/^(?:[\}])/i,/^(?:[^\}]*)/i,/^(?:classDef\s+)/i,/^(?:DEFAULT\s+)/i,/^(?:\w+\s+)/i,/^(?:[^\n]*)/i,/^(?:class\s+)/i,/^(?:(\w+)+((,\s*\w+)*))/i,/^(?:[^\n]*)/i,/^(?:style\s+)/i,/^(?:[\w,]+\s+)/i,/^(?:[^\n]*)/i,/^(?:scale\s+)/i,/^(?:\d+)/i,/^(?:\s+width\b)/i,/^(?:state\s+)/i,/^(?:.*<<fork>>)/i,/^(?:.*<<join>>)/i,/^(?:.*<<choice>>)/i,/^(?:.*\[\[fork\]\])/i,/^(?:.*\[\[join\]\])/i,/^(?:.*\[\[choice\]\])/i,/^(?:.*direction\s+TB[^\n]*)/i,/^(?:.*direction\s+BT[^\n]*)/i,/^(?:.*direction\s+RL[^\n]*)/i,/^(?:.*direction\s+LR[^\n]*)/i,/^(?:["])/i,/^(?:\s*as\s+)/i,/^(?:[^\n\{]*)/i,/^(?:["])/i,/^(?:[^"]*)/i,/^(?:[^\n\s\{]+)/i,/^(?:\n)/i,/^(?:\{)/i,/^(?:%%(?!\{)[^\n]*)/i,/^(?:\})/i,/^(?:[\n])/i,/^(?:note\s+)/i,/^(?:left of\b)/i,/^(?:right of\b)/i,/^(?:")/i,/^(?:\s*as\s*)/i,/^(?:["])/i,/^(?:[^"]*)/i,/^(?:[^\n]*)/i,/^(?:\s*[^:\n\s\-]+)/i,/^(?:\s*:[^:\n;]+)/i,/^(?:[\s\S]*?end note\b)/i,/^(?:stateDiagram\s+)/i,/^(?:stateDiagram-v2\s+)/i,/^(?:hide empty description\b)/i,/^(?:\[\*\])/i,/^(?:[^:\n\s\-\{]+)/i,/^(?:\s*:(?:[^:\n;]|:[^:\n;])+)/i,/^(?:-->)/i,/^(?:--)/i,/^(?::::)/i,/^(?:$)/i,/^(?:.)/i],conditions:{LINE:{rules:[12,13],inclusive:!1},struct:{rules:[12,13,25,29,32,38,45,46,47,48,57,58,59,60,74,75,76,77,78,79],inclusive:!1},FLOATING_NOTE_ID:{rules:[67],inclusive:!1},FLOATING_NOTE:{rules:[64,65,66],inclusive:!1},NOTE_TEXT:{rules:[69,70],inclusive:!1},NOTE_ID:{rules:[68],inclusive:!1},NOTE:{rules:[61,62,63],inclusive:!1},STYLEDEF_STYLEOPTS:{rules:[],inclusive:!1},STYLEDEF_STYLES:{rules:[34],inclusive:!1},STYLE_IDS:{rules:[],inclusive:!1},STYLE:{rules:[33],inclusive:!1},CLASS_STYLE:{rules:[31],inclusive:!1},CLASS:{rules:[30],inclusive:!1},CLASSDEFID:{rules:[28],inclusive:!1},CLASSDEF:{rules:[26,27],inclusive:!1},acc_descr_multiline:{rules:[23,24],inclusive:!1},acc_descr:{rules:[21],inclusive:!1},acc_title:{rules:[19],inclusive:!1},SCALE:{rules:[16,17,36,37],inclusive:!1},ALIAS:{rules:[],inclusive:!1},STATE_ID:{rules:[51],inclusive:!1},STATE_STRING:{rules:[52,53],inclusive:!1},FORK_STATE:{rules:[],inclusive:!1},STATE:{rules:[12,13,39,40,41,42,43,44,49,50,54,55,56],inclusive:!1},ID:{rules:[12,13],inclusive:!1},INITIAL:{rules:[0,1,2,3,4,5,6,7,8,9,10,11,13,14,15,18,20,22,25,29,32,35,38,56,60,71,72,73,74,75,76,77,79,80,81],inclusive:!0}}},(0,a.__name)(N,"Parser"),N.prototype=O,O.Parser=N,new N}();o.parser=o;var l=o,c="TB",h="state",d="root",u="relation",p="default",g="divider",y="fill:none",m="fill: #333",_="markdown",f="normal",S="rect",T="rectWithTitle",k="divider",b="roundedWithTitle",E="statediagram",D=`${E}-state`,C="transition",$=`${C} note-edge`,x=`${E}-note`,A=`${E}-cluster`,I=`${E}-cluster-alt`,L="parent",v="note",w="----",O=`${w}${v}`,N=`${w}${L}`,R=(0,a.__name)((t,e=c)=>{if(!t.doc)return e;let s=e;for(let e of t.doc)"dir"===e.stmt&&(s=e.value);return s},"getDir"),B={getClasses:(0,a.__name)(function(t,e){return e.db.getClasses()},"getClasses"),draw:(0,a.__name)(async function(t,o,l,c){a.log.info("REF0:"),a.log.info("Drawing state diagram (v2)",o);let{securityLevel:h,state:d,layout:u}=(0,n.getConfig2)();c.db.extract(c.db.getRootDocV2());let p=c.db.getData(),g=(0,e.getDiagramElement)(o,h);p.type=c.type,p.layoutAlgorithm=u,p.nodeSpacing=d?.nodeSpacing||50,p.rankSpacing=d?.rankSpacing||50,"neo"===(0,n.getConfig2)().look?p.markers=["barbNeo"]:p.markers=["barb"],p.diagramId=o,await (0,i.render)(p,g);try{("function"==typeof c.db.getLinks?c.db.getLinks():new Map).forEach((t,e)=>{let s,i="string"==typeof e?e:"string"==typeof e?.id?e.id:"";if(!i)return void a.log.warn("⚠️ Invalid or missing stateId from key:",JSON.stringify(e));let r=g.node()?.querySelectorAll("g");if(r?.forEach(t=>{t.textContent?.trim()===i&&(s=t)}),!s)return void a.log.warn("⚠️ Could not find node matching text:",i);let n=s.parentNode;if(!n)return void a.log.warn("⚠️ Node has no parent, cannot wrap:",i);let o=document.createElementNS("http://www.w3.org/2000/svg","a"),l=t.url.replace(/^"+|"+$/g,"");if(o.setAttributeNS("http://www.w3.org/1999/xlink","xlink:href",l),o.setAttribute("target","_blank"),t.tooltip){let e=t.tooltip.replace(/^"+|"+$/g,"");o.setAttribute("title",e)}n.replaceChild(o,s),o.appendChild(s),a.log.info("🔗 Wrapped node in <a> tag for:",i,t.url)})}catch(t){a.log.error("❌ Error injecting clickable links:",t)}r.utils_default.insertTitle(g,"statediagramTitleText",d?.titleTopMargin??25,c.db.getDiagramTitle()),(0,s.setupViewPortForSVG)(g,8,E,d?.useMaxWidth??!0)},"draw"),getDir:R},F=new Map,Y=0;function P(t="",e=0,s="",i=w){let r=null!==s&&s.length>0?`${i}${s}`:"";return`state-${t}${r}-${e}`}(0,a.__name)(P,"stateDomId");var G=(0,a.__name)((t,e,s,i,r,o,l,c)=>{a.log.trace("items",e),e.forEach(e=>{switch(e.stmt){case h:case p:M(t,e,s,i,r,o,l,c);break;case u:{M(t,e.state1,s,i,r,o,l,c),M(t,e.state2,s,i,r,o,l,c);let a="neo"===l,h={id:"edge"+Y,start:e.state1.id,end:e.state2.id,arrowhead:"normal",arrowTypeEnd:a?"arrow_barb_neo":"arrow_barb",style:y,labelStyle:"",label:n.common_default.sanitizeText(e.description??"",(0,n.getConfig2)()),arrowheadStyle:m,labelpos:"c",labelType:_,thickness:f,classes:C,look:l};r.push(h),Y++}}})},"setupDoc"),W=(0,a.__name)((t,e=c)=>{let s=e;if(t.doc)for(let e of t.doc)"dir"===e.stmt&&(s=e.value);return s},"getDir");function j(t,e,s){if(!e.id||"</join></fork>"===e.id||"</choice>"===e.id)return;e.cssClasses&&(Array.isArray(e.cssCompiledStyles)||(e.cssCompiledStyles=[]),e.cssClasses.split(" ").forEach(t=>{let i=s.get(t);i&&(e.cssCompiledStyles=[...e.cssCompiledStyles??[],...i.styles])}));let i=t.find(t=>t.id===e.id);i?Object.assign(i,e):t.push(e)}function z(t){return t?.classes?.join(" ")??""}function U(t){return t?.styles??[]}(0,a.__name)(j,"insertOrUpdateNode"),(0,a.__name)(z,"getClassesFromDbInfo"),(0,a.__name)(U,"getStylesFromDbInfo");var M=(0,a.__name)((t,e,s,i,r,o,l,c)=>{let h=e.id,d=s.get(h),u=z(d),E=U(d),C=(0,n.getConfig2)();if(a.log.info("dataFetcher parsedItem",e,d,E),"root"!==h){let s=S;!0===e.start?s="stateStart":!1===e.start&&(s="stateEnd"),e.type!==p&&(s=e.type),F.get(h)||F.set(h,{id:h,shape:s,description:n.common_default.sanitizeText(h,C),cssClasses:`${u} ${D}`,cssStyles:E});let d=F.get(h);e.description&&(Array.isArray(d.description)?(d.shape=T,d.description.push(e.description)):d.description?.length&&d.description.length>0?(d.shape=T,d.description===h?d.description=[e.description]:d.description=[d.description,e.description]):(d.shape=S,d.description=e.description),d.description=n.common_default.sanitizeTextOrArray(d.description,C)),d.description?.length===1&&d.shape===T&&("group"===d.type?d.shape=b:d.shape=S),!d.type&&e.doc&&(a.log.info("Setting cluster for XCX",h,W(e)),d.type="group",d.isGroup=!0,d.dir=W(e),d.shape=e.type===g?k:b,d.cssClasses=`${d.cssClasses} ${A} ${o?I:""}`);let w={labelStyle:"",shape:d.shape,label:d.description,cssClasses:d.cssClasses,cssCompiledStyles:[],cssStyles:d.cssStyles,id:h,dir:d.dir,domId:P(h,Y),type:d.type,isGroup:"group"===d.type,padding:8,rx:10,ry:10,look:l,labelType:"markdown"};if(w.shape===k&&(w.label=""),t&&"root"!==t.id&&(a.log.trace("Setting node ",h," to be child of its parent ",t.id),w.parentId=t.id),w.centerLabel=!0,e.note){let t={labelStyle:"",shape:"note",label:e.note.text,labelType:"markdown",cssClasses:x,cssStyles:[],cssCompiledStyles:[],id:h+O+"-"+Y,domId:P(h,Y,v),type:d.type,isGroup:"group"===d.type,padding:C.flowchart?.padding,look:l,position:e.note.position},s=h+N,n={labelStyle:"",shape:"noteGroup",label:e.note.text,cssClasses:d.cssClasses,cssStyles:[],id:h+N,domId:P(h,Y,L),type:"group",isGroup:!0,padding:16,look:l,position:e.note.position};Y++,n.id=s,t.parentId=s,j(i,n,c),j(i,t,c),j(i,w,c);let a=h,o=t.id;"left of"===e.note.position&&(a=t.id,o=h),r.push({id:a+"-"+o,start:a,end:o,arrowhead:"none",arrowTypeEnd:"",style:y,labelStyle:"",classes:$,arrowheadStyle:m,labelpos:"c",labelType:_,thickness:f,look:l})}else j(i,w,c)}e.doc&&(a.log.trace("Adding nodes children "),G(e,e.doc,s,i,r,!o,l,c))},"dataFetcher"),K=(0,a.__name)(()=>{F.clear(),Y=0},"reset"),H={START_NODE:"[*]",START_TYPE:"start",END_NODE:"[*]",END_TYPE:"end",COLOR_KEYWORD:"color",FILL_KEYWORD:"fill",BG_FILL:"bgFill",STYLECLASS_SEP:","},V=(0,a.__name)(()=>new Map,"newClassesList"),X=(0,a.__name)(()=>({relations:[],states:new Map,documents:{}}),"newDoc"),J=(0,a.__name)(t=>JSON.parse(JSON.stringify(t)),"clone"),q=class{constructor(t){this.version=t,this.nodes=[],this.edges=[],this.rootDoc=[],this.classes=V(),this.documents={root:X()},this.currentDocument=this.documents.root,this.startEndCount=0,this.dividerCnt=0,this.links=new Map,this.getAccTitle=n.getAccTitle,this.setAccTitle=n.setAccTitle,this.getAccDescription=n.getAccDescription,this.setAccDescription=n.setAccDescription,this.setDiagramTitle=n.setDiagramTitle,this.getDiagramTitle=n.getDiagramTitle,this.clear(),this.setRootDoc=this.setRootDoc.bind(this),this.getDividerId=this.getDividerId.bind(this),this.setDirection=this.setDirection.bind(this),this.trimColon=this.trimColon.bind(this)}static{(0,a.__name)(this,"StateDB")}static{this.relationType={AGGREGATION:0,EXTENSION:1,COMPOSITION:2,DEPENDENCY:3}}extract(t){for(let e of(this.clear(!0),Array.isArray(t)?t:t.doc))switch(e.stmt){case h:this.addState(e.id.trim(),e.type,e.doc,e.description,e.note);break;case u:this.addRelation(e.state1,e.state2,e.description);break;case"classDef":this.addStyleClass(e.id.trim(),e.classes);break;case"style":this.handleStyleDef(e);break;case"applyClass":this.setCssClass(e.id.trim(),e.styleClass);break;case"click":this.addLink(e.id,e.url,e.tooltip)}let e=this.getStates(),s=(0,n.getConfig2)();for(let t of(K(),M(void 0,this.getRootDocV2(),e,this.nodes,this.edges,!0,s.look,this.classes),this.nodes))if(Array.isArray(t.label)){if(t.description=t.label.slice(1),t.isGroup&&t.description.length>0)throw Error(`Group nodes can only have label. Remove the additional description for node [${t.id}]`);t.label=t.label[0]}}handleStyleDef(t){let e=t.id.trim().split(","),s=t.styleClass.split(",");for(let t of e){let e=this.getState(t);if(!e){let s=t.trim();this.addState(s),e=this.getState(s)}e&&(e.styles=s.map(t=>t.replace(/;/g,"")?.trim()))}}setRootDoc(t){a.log.info("Setting root doc",t),this.rootDoc=t,1===this.version?this.extract(t):this.extract(this.getRootDocV2())}docTranslator(t,e,s){if(e.stmt===u){this.docTranslator(t,e.state1,!0),this.docTranslator(t,e.state2,!1);return}if(e.stmt===h&&(e.id===H.START_NODE?(e.id=t.id+(s?"_start":"_end"),e.start=s):e.id=e.id.trim()),e.stmt!==d&&e.stmt!==h||!e.doc)return;let i=[],n=[];for(let t of e.doc)if(t.type===g){let e=J(t);e.doc=J(n),i.push(e),n=[]}else n.push(t);if(i.length>0&&n.length>0){let t={stmt:h,id:(0,r.generateId)(),type:"divider",doc:J(n)};i.push(J(t)),e.doc=i}e.doc.forEach(t=>this.docTranslator(e,t,!0))}getRootDocV2(){return this.docTranslator({id:d,stmt:d},{id:d,stmt:d,doc:this.rootDoc},!0),{id:d,doc:this.rootDoc}}addState(t,e=p,s,i,r,o,l,c){let d=t?.trim();if(this.currentDocument.states.has(d)){let t=this.currentDocument.states.get(d);if(!t)throw Error(`State not found: ${d}`);t.doc||(t.doc=s),t.type||(t.type=e)}else a.log.info("Adding state ",d,i),this.currentDocument.states.set(d,{stmt:h,id:d,descriptions:[],type:e,doc:s,note:r,classes:[],styles:[],textStyles:[]});if(i&&(a.log.info("Setting state description",d,i),(Array.isArray(i)?i:[i]).forEach(t=>this.addDescription(d,t.trim()))),r){let t=this.currentDocument.states.get(d);if(!t)throw Error(`State not found: ${d}`);t.note=r,t.note.text=n.common_default.sanitizeText(t.note.text,(0,n.getConfig2)())}o&&(a.log.info("Setting state classes",d,o),(Array.isArray(o)?o:[o]).forEach(t=>this.setCssClass(d,t.trim()))),l&&(a.log.info("Setting state styles",d,l),(Array.isArray(l)?l:[l]).forEach(t=>this.setStyle(d,t.trim()))),c&&(a.log.info("Setting state styles",d,l),(Array.isArray(c)?c:[c]).forEach(t=>this.setTextStyle(d,t.trim())))}clear(t){this.nodes=[],this.edges=[],this.documents={root:X()},this.currentDocument=this.documents.root,this.startEndCount=0,this.classes=V(),t||(this.links=new Map,(0,n.clear)())}getState(t){return this.currentDocument.states.get(t)}getStates(){return this.currentDocument.states}logDocuments(){a.log.info("Documents = ",this.documents)}getRelations(){return this.currentDocument.relations}addLink(t,e,s){this.links.set(t,{url:e,tooltip:s}),a.log.warn("Adding link",t,e,s)}getLinks(){return this.links}startIdIfNeeded(t=""){return t===H.START_NODE?(this.startEndCount++,`${H.START_TYPE}${this.startEndCount}`):t}startTypeIfNeeded(t="",e=p){return t===H.START_NODE?H.START_TYPE:e}endIdIfNeeded(t=""){return t===H.END_NODE?(this.startEndCount++,`${H.END_TYPE}${this.startEndCount}`):t}endTypeIfNeeded(t="",e=p){return t===H.END_NODE?H.END_TYPE:e}addRelationObjs(t,e,s=""){let i=this.startIdIfNeeded(t.id.trim()),r=this.startTypeIfNeeded(t.id.trim(),t.type),a=this.startIdIfNeeded(e.id.trim()),o=this.startTypeIfNeeded(e.id.trim(),e.type);this.addState(i,r,t.doc,t.description,t.note,t.classes,t.styles,t.textStyles),this.addState(a,o,e.doc,e.description,e.note,e.classes,e.styles,e.textStyles),this.currentDocument.relations.push({id1:i,id2:a,relationTitle:n.common_default.sanitizeText(s,(0,n.getConfig2)())})}addRelation(t,e,s){if("object"==typeof t&&"object"==typeof e)this.addRelationObjs(t,e,s);else if("string"==typeof t&&"string"==typeof e){let i=this.startIdIfNeeded(t.trim()),r=this.startTypeIfNeeded(t),a=this.endIdIfNeeded(e.trim()),o=this.endTypeIfNeeded(e);this.addState(i,r),this.addState(a,o),this.currentDocument.relations.push({id1:i,id2:a,relationTitle:s?n.common_default.sanitizeText(s,(0,n.getConfig2)()):void 0})}}addDescription(t,e){let s=this.currentDocument.states.get(t),i=e.startsWith(":")?e.replace(":","").trim():e;s?.descriptions?.push(n.common_default.sanitizeText(i,(0,n.getConfig2)()))}cleanupLabel(t){return t.startsWith(":")?t.slice(2).trim():t.trim()}getDividerId(){return this.dividerCnt++,`divider-id-${this.dividerCnt}`}addStyleClass(t,e=""){this.classes.has(t)||this.classes.set(t,{id:t,styles:[],textStyles:[]});let s=this.classes.get(t);e&&s&&e.split(H.STYLECLASS_SEP).forEach(t=>{let e=t.replace(/([^;]*);/,"$1").trim();if(RegExp(H.COLOR_KEYWORD).exec(t)){let t=e.replace(H.FILL_KEYWORD,H.BG_FILL).replace(H.COLOR_KEYWORD,H.FILL_KEYWORD);s.textStyles.push(t)}s.styles.push(e)})}getClasses(){return this.classes}setCssClass(t,e){t.split(",").forEach(t=>{let s=this.getState(t);if(!s){let e=t.trim();this.addState(e),s=this.getState(e)}s?.classes?.push(e)})}setStyle(t,e){this.getState(t)?.styles?.push(e)}setTextStyle(t,e){this.getState(t)?.textStyles?.push(e)}getDirectionStatement(){return this.rootDoc.find(t=>"dir"===t.stmt)}getDirection(){return this.getDirectionStatement()?.value??"TB"}setDirection(t){let e=this.getDirectionStatement();e?e.value=t:this.rootDoc.unshift({stmt:"dir",value:t})}trimColon(t){return t.startsWith(":")?t.slice(1).trim():t.trim()}getData(){let t=(0,n.getConfig2)();return{nodes:this.nodes,edges:this.edges,other:{},config:t,direction:R(this.getRootDocV2())}}getConfig(){return(0,n.getConfig2)().state}},Q=(0,a.__name)(t=>`
defs [id$="-barbEnd"] {
    fill: ${t.transitionColor};
    stroke: ${t.transitionColor};
  }
g.stateGroup text {
  fill: ${t.nodeBorder};
  stroke: none;
  font-size: 10px;
}
g.stateGroup text {
  fill: ${t.textColor};
  stroke: none;
  font-size: 10px;

}
g.stateGroup .state-title {
  font-weight: bolder;
  fill: ${t.stateLabelColor};
}

g.stateGroup rect {
  fill: ${t.mainBkg};
  stroke: ${t.nodeBorder};
}

g.stateGroup line {
  stroke: ${t.lineColor};
  stroke-width: ${t.strokeWidth||1};
}

.transition {
  stroke: ${t.transitionColor};
  stroke-width: ${t.strokeWidth||1};
  fill: none;
}

.stateGroup .composit {
  fill: ${t.background};
  border-bottom: 1px
}

.stateGroup .alt-composit {
  fill: #e0e0e0;
  border-bottom: 1px
}

.state-note {
  stroke: ${t.noteBorderColor};
  fill: ${t.noteBkgColor};

  text {
    fill: ${t.noteTextColor};
    stroke: none;
    font-size: 10px;
  }
}

.stateLabel .box {
  stroke: none;
  stroke-width: 0;
  fill: ${t.mainBkg};
  opacity: 0.5;
}

.edgeLabel .label rect {
  fill: ${t.labelBackgroundColor};
  opacity: 0.5;
}
.edgeLabel {
  background-color: ${t.edgeLabelBackground};
  p {
    background-color: ${t.edgeLabelBackground};
  }
  rect {
    opacity: 0.5;
    background-color: ${t.edgeLabelBackground};
    fill: ${t.edgeLabelBackground};
  }
  text-align: center;
}
.edgeLabel .label text {
  fill: ${t.transitionLabelColor||t.tertiaryTextColor};
}
.label div .edgeLabel {
  color: ${t.transitionLabelColor||t.tertiaryTextColor};
}

.stateLabel text {
  fill: ${t.stateLabelColor};
  font-size: 10px;
  font-weight: bold;
}

.node circle.state-start {
  fill: ${t.specialStateColor};
  stroke: ${t.specialStateColor};
}

.node .fork-join {
  fill: ${t.specialStateColor};
  stroke: ${t.specialStateColor};
}

.node circle.state-end {
  fill: ${t.innerEndBackground};
  stroke: ${t.background};
  stroke-width: 1.5
}
.end-state-inner {
  fill: ${t.compositeBackground||t.background};
  // stroke: ${t.background};
  stroke-width: 1.5
}

.node rect {
  fill: ${t.stateBkg||t.mainBkg};
  stroke: ${t.stateBorder||t.nodeBorder};
  stroke-width: ${t.strokeWidth||1}px;
}
.node polygon {
  fill: ${t.mainBkg};
  stroke: ${t.stateBorder||t.nodeBorder};;
  stroke-width: ${t.strokeWidth||1}px;
}
[id$="-barbEnd"] {
  fill: ${t.lineColor};
}

.statediagram-cluster rect {
  fill: ${t.compositeTitleBackground};
  stroke: ${t.stateBorder||t.nodeBorder};
  stroke-width: ${t.strokeWidth||1}px;
}

.cluster-label, .nodeLabel {
  color: ${t.stateLabelColor};
  // line-height: 1;
}

.statediagram-cluster rect.outer {
  rx: 5px;
  ry: 5px;
}
.statediagram-state .divider {
  stroke: ${t.stateBorder||t.nodeBorder};
}

.statediagram-state .title-state {
  rx: 5px;
  ry: 5px;
}
.statediagram-cluster.statediagram-cluster .inner {
  fill: ${t.compositeBackground||t.background};
}
.statediagram-cluster.statediagram-cluster-alt .inner {
  fill: ${t.altBackground?t.altBackground:"#efefef"};
}

.statediagram-cluster .inner {
  rx:0;
  ry:0;
}

.statediagram-state rect.basic {
  rx: 5px;
  ry: 5px;
}
.statediagram-state rect.divider {
  stroke-dasharray: 10,10;
  fill: ${t.altBackground?t.altBackground:"#efefef"};
}

.note-edge {
  stroke-dasharray: 5;
}

.statediagram-note rect {
  fill: ${t.noteBkgColor};
  stroke: ${t.noteBorderColor};
  stroke-width: 1px;
  rx: 0;
  ry: 0;
}
.statediagram-note rect {
  fill: ${t.noteBkgColor};
  stroke: ${t.noteBorderColor};
  stroke-width: 1px;
  rx: 0;
  ry: 0;
}

.statediagram-note text {
  fill: ${t.noteTextColor};
}

.statediagram-note .nodeLabel {
  color: ${t.noteTextColor};
}
.statediagram .edgeLabel {
  color: red; // ${t.noteTextColor};
}

[id$="-dependencyStart"], [id$="-dependencyEnd"] {
  fill: ${t.lineColor};
  stroke: ${t.lineColor};
  stroke-width: ${t.strokeWidth||1};
}

.statediagramTitleText {
  text-anchor: middle;
  font-size: 18px;
  fill: ${t.textColor};
}

[data-look="neo"].statediagram-cluster rect {
  fill: ${t.mainBkg};
  stroke: ${t.useGradient?"url("+t.svgId+"-gradient)":t.stateBorder||t.nodeBorder};
  stroke-width: ${t.strokeWidth??1};
}
[data-look="neo"].statediagram-cluster rect.outer {
  rx: ${t.radius}px;
  ry: ${t.radius}px;
  filter: ${t.dropShadow?t.dropShadow.replace("url(#drop-shadow)",`url(${t.svgId}-drop-shadow)`):"none"}
}
`,"getStyles")}]);