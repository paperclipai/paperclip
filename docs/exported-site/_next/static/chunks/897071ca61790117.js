(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,39754,(t,e,i)=>{t.e,e.exports=function(t,e,i){var n=function(t){return t.add(4-t.isoWeekday(),"day")},a=e.prototype;a.isoWeekYear=function(){return n(this).year()},a.isoWeek=function(t){if(!this.$utils().u(t))return this.add(7*(t-this.isoWeek()),"day");var e,a,r,s=n(this),o=(e=this.isoWeekYear(),r=4-(a=(this.$u?i.utc:i)().year(e).startOf("year")).isoWeekday(),a.isoWeekday()>4&&(r+=7),a.add(r,"day"));return s.diff(o,"week")+1},a.isoWeekday=function(t){return this.$utils().u(t)?this.day()||7:this.day(this.day()%7?t:t-7)};var r=a.startOf;a.startOf=function(t,e){var i=this.$utils(),n=!!i.u(e)||e;return"isoweek"===i.p(t)?n?this.date(this.date()-(this.isoWeekday()-1)).startOf("day"):this.date(this.date()-1-(this.isoWeekday()-1)+7).endOf("day"):r.bind(this)(t,e)}}},346628,(t,e,i)=>{t.e,e.exports=function(){"use strict";var t={LTS:"h:mm:ss A",LT:"h:mm A",L:"MM/DD/YYYY",LL:"MMMM D, YYYY",LLL:"MMMM D, YYYY h:mm A",LLLL:"dddd, MMMM D, YYYY h:mm A"},e=/(\[[^[]*\])|([-_:/.,()\s]+)|(A|a|Q|YYYY|YY?|ww?|MM?M?M?|Do|DD?|hh?|HH?|mm?|ss?|S{1,3}|z|ZZ?)/g,i=/\d/,n=/\d\d/,a=/\d\d?/,r=/\d*[^-_:/,()\s\d]+/,s={},o=function(t){return(t*=1)+(t>68?1900:2e3)},c=function(t){return function(e){this[t]=+e}},l=[/[+-]\d\d:?(\d\d)?|Z/,function(t){(this.zone||(this.zone={})).offset=function(t){if(!t||"Z"===t)return 0;var e=t.match(/([+-]|\d\d)/g),i=60*e[1]+(+e[2]||0);return 0===i?0:"+"===e[0]?-i:i}(t)}],d=function(t){var e=s[t];return e&&(e.indexOf?e:e.s.concat(e.f))},u=function(t,e){var i,n=s.meridiem;if(n){for(var a=1;a<=24;a+=1)if(t.indexOf(n(a,0,e))>-1){i=a>12;break}}else i=t===(e?"pm":"PM");return i},h={A:[r,function(t){this.afternoon=u(t,!1)}],a:[r,function(t){this.afternoon=u(t,!0)}],Q:[i,function(t){this.month=3*(t-1)+1}],S:[i,function(t){this.milliseconds=100*t}],SS:[n,function(t){this.milliseconds=10*t}],SSS:[/\d{3}/,function(t){this.milliseconds=+t}],s:[a,c("seconds")],ss:[a,c("seconds")],m:[a,c("minutes")],mm:[a,c("minutes")],H:[a,c("hours")],h:[a,c("hours")],HH:[a,c("hours")],hh:[a,c("hours")],D:[a,c("day")],DD:[n,c("day")],Do:[r,function(t){var e=s.ordinal,i=t.match(/\d+/);if(this.day=i[0],e)for(var n=1;n<=31;n+=1)e(n).replace(/\[|\]/g,"")===t&&(this.day=n)}],w:[a,c("week")],ww:[n,c("week")],M:[a,c("month")],MM:[n,c("month")],MMM:[r,function(t){var e=d("months"),i=(d("monthsShort")||e.map(function(t){return t.slice(0,3)})).indexOf(t)+1;if(i<1)throw Error();this.month=i%12||i}],MMMM:[r,function(t){var e=d("months").indexOf(t)+1;if(e<1)throw Error();this.month=e%12||e}],Y:[/[+-]?\d+/,c("year")],YY:[n,function(t){this.year=o(t)}],YYYY:[/\d{4}/,c("year")],Z:l,ZZ:l};return function(i,n,a){a.p.customParseFormat=!0,i&&i.parseTwoDigitYear&&(o=i.parseTwoDigitYear);var r=n.prototype,c=r.parse;r.parse=function(i){var n=i.date,r=i.utc,o=i.args;this.$u=r;var l=o[1];if("string"==typeof l){var d=!0===o[2],u=!0===o[3],f=o[2];u&&(f=o[2]),s=this.$locale(),!d&&f&&(s=a.Ls[f]),this.$d=function(i,n,a,r){try{if(["x","X"].indexOf(n)>-1)return new Date(("X"===n?1e3:1)*i);var o=(function(i){var n,a;n=i,a=s&&s.formats;for(var r=(i=n.replace(/(\[[^\]]+])|(LTS?|l{1,4}|L{1,4})/g,function(e,i,n){var r=n&&n.toUpperCase();return i||a[n]||t[n]||a[r].replace(/(\[[^\]]+])|(MMMM|MM|DD|dddd)/g,function(t,e,i){return e||i.slice(1)})})).match(e),o=r.length,c=0;c<o;c+=1){var l=r[c],d=h[l],u=d&&d[0],f=d&&d[1];r[c]=f?{regex:u,parser:f}:l.replace(/^\[|\]$/g,"")}return function(t){for(var e={},i=0,n=0;i<o;i+=1){var a=r[i];if("string"==typeof a)n+=a.length;else{var s=a.regex,c=a.parser,l=t.slice(n),d=s.exec(l)[0];c.call(e,d),t=t.replace(d,"")}}return function(t){var e=t.afternoon;if(void 0!==e){var i=t.hours;e?i<12&&(t.hours+=12):12===i&&(t.hours=0),delete t.afternoon}}(e),e}})(n)(i),c=o.year,l=o.month,d=o.day,u=o.hours,f=o.minutes,m=o.seconds,y=o.milliseconds,k=o.zone,g=o.week,p=new Date,_=d||(c||l?1:p.getDate()),b=c||p.getFullYear(),T=0;c&&!l||(T=l>0?l-1:p.getMonth());var v,x=u||0,w=f||0,D=m||0,$=y||0;return k?new Date(Date.UTC(b,T,_,x,w,D,$+60*k.offset*1e3)):a?new Date(Date.UTC(b,T,_,x,w,D,$)):(v=new Date(b,T,_,x,w,D,$),g&&(v=r(v).week(g).toDate()),v)}catch(t){return new Date("")}}(n,l,r,a),this.init(),f&&!0!==f&&(this.$L=this.locale(f).$L),(d||u)&&n!=this.format(l)&&(this.$d=new Date("")),s={}}else if(l instanceof Array)for(var m=l.length,y=1;y<=m;y+=1){o[1]=l[y-1];var k=a.apply(this,o);if(k.isValid()){this.$d=k.$d,this.$L=k.$L,this.init();break}y===m&&(this.$d=new Date(""))}else c.call(this,i)}}}()},83593,(t,e,i)=>{t.e,e.exports=function(t,e){var i=e.prototype,n=i.format;i.format=function(t){var e=this,i=this.$locale();if(!this.isValid())return n.bind(this)(t);var a=this.$utils(),r=(t||"YYYY-MM-DDTHH:mm:ssZ").replace(/\[([^\]]+)]|Q|wo|ww|w|WW|W|zzz|z|gggg|GGGG|Do|X|x|k{1,2}|S/g,function(t){switch(t){case"Q":return Math.ceil((e.$M+1)/3);case"Do":return i.ordinal(e.$D);case"gggg":return e.weekYear();case"GGGG":return e.isoWeekYear();case"wo":return i.ordinal(e.week(),"W");case"w":case"ww":return a.s(e.week(),"w"===t?1:2,"0");case"W":case"WW":return a.s(e.isoWeek(),"W"===t?1:2,"0");case"k":case"kk":return a.s(String(0===e.$H?24:e.$H),"k"===t?1:2,"0");case"X":return Math.floor(e.$d.getTime()/1e3);case"x":return e.$d.getTime();case"z":return"["+e.offsetName()+"]";case"zzz":return"["+e.offsetName("long")+"]";default:return t}});return n.bind(this)(r)}}},680859,t=>{"use strict";t.s(["diagram",()=>tU]);var e,i,n,a=t.i(905664),r=t.i(311495),s=t.i(56562),o=t.i(139941),c=t.i(822315),l=t.i(39754),d=t.i(346628),u=t.i(83593);t.i(947716);var h=t.i(723685),f=t.i(899045),m=t.i(997253),y=t.i(927622),k=t.i(282803),g=t.i(729418),p=t.i(677803),_=t.i(894496),b=t.i(672294),T=t.i(66532),v=t.i(802991),x=t.i(173337),w=t.i(718416),D=t.i(212644),$=t.i(770853),C=function(){var t=(0,s.__name)(function(t,e,i,n){for(i=i||{},n=t.length;n--;i[t[n]]=e);return i},"o"),e=[6,8,10,12,13,14,15,16,17,18,20,21,22,23,24,25,26,27,28,29,30,31,33,35,36,38,40],i=[1,26],n=[1,27],a=[1,28],r=[1,29],o=[1,30],c=[1,31],l=[1,32],d=[1,33],u=[1,34],h=[1,9],f=[1,10],m=[1,11],y=[1,12],k=[1,13],g=[1,14],p=[1,15],_=[1,16],b=[1,19],T=[1,20],v=[1,21],x=[1,22],w=[1,23],D=[1,25],$=[1,35],C={trace:(0,s.__name)(function(){},"trace"),yy:{},symbols_:{error:2,start:3,gantt:4,document:5,EOF:6,line:7,SPACE:8,statement:9,NL:10,weekday:11,weekday_monday:12,weekday_tuesday:13,weekday_wednesday:14,weekday_thursday:15,weekday_friday:16,weekday_saturday:17,weekday_sunday:18,weekend:19,weekend_friday:20,weekend_saturday:21,dateFormat:22,inclusiveEndDates:23,topAxis:24,axisFormat:25,tickInterval:26,excludes:27,includes:28,todayMarker:29,title:30,acc_title:31,acc_title_value:32,acc_descr:33,acc_descr_value:34,acc_descr_multiline_value:35,section:36,clickStatement:37,taskTxt:38,taskData:39,click:40,callbackname:41,callbackargs:42,href:43,clickStatementDebug:44,$accept:0,$end:1},terminals_:{2:"error",4:"gantt",6:"EOF",8:"SPACE",10:"NL",12:"weekday_monday",13:"weekday_tuesday",14:"weekday_wednesday",15:"weekday_thursday",16:"weekday_friday",17:"weekday_saturday",18:"weekday_sunday",20:"weekend_friday",21:"weekend_saturday",22:"dateFormat",23:"inclusiveEndDates",24:"topAxis",25:"axisFormat",26:"tickInterval",27:"excludes",28:"includes",29:"todayMarker",30:"title",31:"acc_title",32:"acc_title_value",33:"acc_descr",34:"acc_descr_value",35:"acc_descr_multiline_value",36:"section",38:"taskTxt",39:"taskData",40:"click",41:"callbackname",42:"callbackargs",43:"href"},productions_:[0,[3,3],[5,0],[5,2],[7,2],[7,1],[7,1],[7,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[19,1],[19,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,1],[9,2],[9,2],[9,1],[9,1],[9,1],[9,2],[37,2],[37,3],[37,3],[37,4],[37,3],[37,4],[37,2],[44,2],[44,3],[44,3],[44,4],[44,3],[44,4],[44,2]],performAction:(0,s.__name)(function(t,e,i,n,a,r,s){var o=r.length-1;switch(a){case 1:return r[o-1];case 2:case 6:case 7:this.$=[];break;case 3:r[o-1].push(r[o]),this.$=r[o-1];break;case 4:case 5:this.$=r[o];break;case 8:n.setWeekday("monday");break;case 9:n.setWeekday("tuesday");break;case 10:n.setWeekday("wednesday");break;case 11:n.setWeekday("thursday");break;case 12:n.setWeekday("friday");break;case 13:n.setWeekday("saturday");break;case 14:n.setWeekday("sunday");break;case 15:n.setWeekend("friday");break;case 16:n.setWeekend("saturday");break;case 17:n.setDateFormat(r[o].substr(11)),this.$=r[o].substr(11);break;case 18:n.enableInclusiveEndDates(),this.$=r[o].substr(18);break;case 19:n.TopAxis(),this.$=r[o].substr(8);break;case 20:n.setAxisFormat(r[o].substr(11)),this.$=r[o].substr(11);break;case 21:n.setTickInterval(r[o].substr(13)),this.$=r[o].substr(13);break;case 22:n.setExcludes(r[o].substr(9)),this.$=r[o].substr(9);break;case 23:n.setIncludes(r[o].substr(9)),this.$=r[o].substr(9);break;case 24:n.setTodayMarker(r[o].substr(12)),this.$=r[o].substr(12);break;case 27:n.setDiagramTitle(r[o].substr(6)),this.$=r[o].substr(6);break;case 28:this.$=r[o].trim(),n.setAccTitle(this.$);break;case 29:case 30:this.$=r[o].trim(),n.setAccDescription(this.$);break;case 31:n.addSection(r[o].substr(8)),this.$=r[o].substr(8);break;case 33:n.addTask(r[o-1],r[o]),this.$="task";break;case 34:this.$=r[o-1],n.setClickEvent(r[o-1],r[o],null);break;case 35:this.$=r[o-2],n.setClickEvent(r[o-2],r[o-1],r[o]);break;case 36:this.$=r[o-2],n.setClickEvent(r[o-2],r[o-1],null),n.setLink(r[o-2],r[o]);break;case 37:this.$=r[o-3],n.setClickEvent(r[o-3],r[o-2],r[o-1]),n.setLink(r[o-3],r[o]);break;case 38:this.$=r[o-2],n.setClickEvent(r[o-2],r[o],null),n.setLink(r[o-2],r[o-1]);break;case 39:this.$=r[o-3],n.setClickEvent(r[o-3],r[o-1],r[o]),n.setLink(r[o-3],r[o-2]);break;case 40:this.$=r[o-1],n.setLink(r[o-1],r[o]);break;case 41:case 47:this.$=r[o-1]+" "+r[o];break;case 42:case 43:case 45:this.$=r[o-2]+" "+r[o-1]+" "+r[o];break;case 44:case 46:this.$=r[o-3]+" "+r[o-2]+" "+r[o-1]+" "+r[o]}},"anonymous"),table:[{3:1,4:[1,2]},{1:[3]},t(e,[2,2],{5:3}),{6:[1,4],7:5,8:[1,6],9:7,10:[1,8],11:17,12:i,13:n,14:a,15:r,16:o,17:c,18:l,19:18,20:d,21:u,22:h,23:f,24:m,25:y,26:k,27:g,28:p,29:_,30:b,31:T,33:v,35:x,36:w,37:24,38:D,40:$},t(e,[2,7],{1:[2,1]}),t(e,[2,3]),{9:36,11:17,12:i,13:n,14:a,15:r,16:o,17:c,18:l,19:18,20:d,21:u,22:h,23:f,24:m,25:y,26:k,27:g,28:p,29:_,30:b,31:T,33:v,35:x,36:w,37:24,38:D,40:$},t(e,[2,5]),t(e,[2,6]),t(e,[2,17]),t(e,[2,18]),t(e,[2,19]),t(e,[2,20]),t(e,[2,21]),t(e,[2,22]),t(e,[2,23]),t(e,[2,24]),t(e,[2,25]),t(e,[2,26]),t(e,[2,27]),{32:[1,37]},{34:[1,38]},t(e,[2,30]),t(e,[2,31]),t(e,[2,32]),{39:[1,39]},t(e,[2,8]),t(e,[2,9]),t(e,[2,10]),t(e,[2,11]),t(e,[2,12]),t(e,[2,13]),t(e,[2,14]),t(e,[2,15]),t(e,[2,16]),{41:[1,40],43:[1,41]},t(e,[2,4]),t(e,[2,28]),t(e,[2,29]),t(e,[2,33]),t(e,[2,34],{42:[1,42],43:[1,43]}),t(e,[2,40],{41:[1,44]}),t(e,[2,35],{43:[1,45]}),t(e,[2,36]),t(e,[2,38],{42:[1,46]}),t(e,[2,37]),t(e,[2,39])],defaultActions:{},parseError:(0,s.__name)(function(t,e){if(e.recoverable)this.trace(t);else{var i=Error(t);throw i.hash=e,i}},"parseError"),parse:(0,s.__name)(function(t){var e=this,i=[0],n=[],a=[null],r=[],o=this.table,c="",l=0,d=0,u=0,h=r.slice.call(arguments,1),f=Object.create(this.lexer),m={};for(var y in this.yy)Object.prototype.hasOwnProperty.call(this.yy,y)&&(m[y]=this.yy[y]);f.setInput(t,m),m.lexer=f,m.parser=this,void 0===f.yylloc&&(f.yylloc={});var k=f.yylloc;r.push(k);var g=f.options&&f.options.ranges;function p(){var t;return"number"!=typeof(t=n.pop()||f.lex()||1)&&(t instanceof Array&&(t=(n=t).pop()),t=e.symbols_[t]||t),t}"function"==typeof m.parseError?this.parseError=m.parseError:this.parseError=Object.getPrototypeOf(this).parseError,(0,s.__name)(function(t){i.length=i.length-2*t,a.length=a.length-t,r.length=r.length-t},"popStack"),(0,s.__name)(p,"lex");for(var _,b,T,v,x,w,D,$,C,S={};;){if(T=i[i.length-1],this.defaultActions[T]?v=this.defaultActions[T]:(null==_&&(_=p()),v=o[T]&&o[T][_]),void 0===v||!v.length||!v[0]){var M="";for(w in C=[],o[T])this.terminals_[w]&&w>2&&C.push("'"+this.terminals_[w]+"'");M=f.showPosition?"Parse error on line "+(l+1)+":\n"+f.showPosition()+"\nExpecting "+C.join(", ")+", got '"+(this.terminals_[_]||_)+"'":"Parse error on line "+(l+1)+": Unexpected "+(1==_?"end of input":"'"+(this.terminals_[_]||_)+"'"),this.parseError(M,{text:f.match,token:this.terminals_[_]||_,line:f.yylineno,loc:k,expected:C})}if(v[0]instanceof Array&&v.length>1)throw Error("Parse Error: multiple actions possible at state: "+T+", token: "+_);switch(v[0]){case 1:i.push(_),a.push(f.yytext),r.push(f.yylloc),i.push(v[1]),_=null,b?(_=b,b=null):(d=f.yyleng,c=f.yytext,l=f.yylineno,k=f.yylloc,u>0&&u--);break;case 2:if(D=this.productions_[v[1]][1],S.$=a[a.length-D],S._$={first_line:r[r.length-(D||1)].first_line,last_line:r[r.length-1].last_line,first_column:r[r.length-(D||1)].first_column,last_column:r[r.length-1].last_column},g&&(S._$.range=[r[r.length-(D||1)].range[0],r[r.length-1].range[1]]),void 0!==(x=this.performAction.apply(S,[c,d,l,m,v[1],a,r].concat(h))))return x;D&&(i=i.slice(0,-1*D*2),a=a.slice(0,-1*D),r=r.slice(0,-1*D)),i.push(this.productions_[v[1]][0]),a.push(S.$),r.push(S._$),$=o[i[i.length-2]][i[i.length-1]],i.push($);break;case 3:return!0}}return!0},"parse")};function S(){this.yy={}}return C.lexer={EOF:1,parseError:(0,s.__name)(function(t,e){if(this.yy.parser)this.yy.parser.parseError(t,e);else throw Error(t)},"parseError"),setInput:(0,s.__name)(function(t,e){return this.yy=e||this.yy||{},this._input=t,this._more=this._backtrack=this.done=!1,this.yylineno=this.yyleng=0,this.yytext=this.matched=this.match="",this.conditionStack=["INITIAL"],this.yylloc={first_line:1,first_column:0,last_line:1,last_column:0},this.options.ranges&&(this.yylloc.range=[0,0]),this.offset=0,this},"setInput"),input:(0,s.__name)(function(){var t=this._input[0];return this.yytext+=t,this.yyleng++,this.offset++,this.match+=t,this.matched+=t,t.match(/(?:\r\n?|\n).*/g)?(this.yylineno++,this.yylloc.last_line++):this.yylloc.last_column++,this.options.ranges&&this.yylloc.range[1]++,this._input=this._input.slice(1),t},"input"),unput:(0,s.__name)(function(t){var e=t.length,i=t.split(/(?:\r\n?|\n)/g);this._input=t+this._input,this.yytext=this.yytext.substr(0,this.yytext.length-e),this.offset-=e;var n=this.match.split(/(?:\r\n?|\n)/g);this.match=this.match.substr(0,this.match.length-1),this.matched=this.matched.substr(0,this.matched.length-1),i.length-1&&(this.yylineno-=i.length-1);var a=this.yylloc.range;return this.yylloc={first_line:this.yylloc.first_line,last_line:this.yylineno+1,first_column:this.yylloc.first_column,last_column:i?(i.length===n.length?this.yylloc.first_column:0)+n[n.length-i.length].length-i[0].length:this.yylloc.first_column-e},this.options.ranges&&(this.yylloc.range=[a[0],a[0]+this.yyleng-e]),this.yyleng=this.yytext.length,this},"unput"),more:(0,s.__name)(function(){return this._more=!0,this},"more"),reject:(0,s.__name)(function(){return this.options.backtrack_lexer?(this._backtrack=!0,this):this.parseError("Lexical error on line "+(this.yylineno+1)+". You can only invoke reject() in the lexer when the lexer is of the backtracking persuasion (options.backtrack_lexer = true).\n"+this.showPosition(),{text:"",token:null,line:this.yylineno})},"reject"),less:(0,s.__name)(function(t){this.unput(this.match.slice(t))},"less"),pastInput:(0,s.__name)(function(){var t=this.matched.substr(0,this.matched.length-this.match.length);return(t.length>20?"...":"")+t.substr(-20).replace(/\n/g,"")},"pastInput"),upcomingInput:(0,s.__name)(function(){var t=this.match;return t.length<20&&(t+=this._input.substr(0,20-t.length)),(t.substr(0,20)+(t.length>20?"...":"")).replace(/\n/g,"")},"upcomingInput"),showPosition:(0,s.__name)(function(){var t=this.pastInput(),e=Array(t.length+1).join("-");return t+this.upcomingInput()+"\n"+e+"^"},"showPosition"),test_match:(0,s.__name)(function(t,e){var i,n,a;if(this.options.backtrack_lexer&&(a={yylineno:this.yylineno,yylloc:{first_line:this.yylloc.first_line,last_line:this.last_line,first_column:this.yylloc.first_column,last_column:this.yylloc.last_column},yytext:this.yytext,match:this.match,matches:this.matches,matched:this.matched,yyleng:this.yyleng,offset:this.offset,_more:this._more,_input:this._input,yy:this.yy,conditionStack:this.conditionStack.slice(0),done:this.done},this.options.ranges&&(a.yylloc.range=this.yylloc.range.slice(0))),(n=t[0].match(/(?:\r\n?|\n).*/g))&&(this.yylineno+=n.length),this.yylloc={first_line:this.yylloc.last_line,last_line:this.yylineno+1,first_column:this.yylloc.last_column,last_column:n?n[n.length-1].length-n[n.length-1].match(/\r?\n?/)[0].length:this.yylloc.last_column+t[0].length},this.yytext+=t[0],this.match+=t[0],this.matches=t,this.yyleng=this.yytext.length,this.options.ranges&&(this.yylloc.range=[this.offset,this.offset+=this.yyleng]),this._more=!1,this._backtrack=!1,this._input=this._input.slice(t[0].length),this.matched+=t[0],i=this.performAction.call(this,this.yy,this,e,this.conditionStack[this.conditionStack.length-1]),this.done&&this._input&&(this.done=!1),i)return i;if(this._backtrack)for(var r in a)this[r]=a[r];return!1},"test_match"),next:(0,s.__name)(function(){if(this.done)return this.EOF;this._input||(this.done=!0),this._more||(this.yytext="",this.match="");for(var t,e,i,n,a=this._currentRules(),r=0;r<a.length;r++)if((i=this._input.match(this.rules[a[r]]))&&(!e||i[0].length>e[0].length)){if(e=i,n=r,this.options.backtrack_lexer){if(!1!==(t=this.test_match(i,a[r])))return t;if(!this._backtrack)return!1;e=!1;continue}if(!this.options.flex)break}return e?!1!==(t=this.test_match(e,a[n]))&&t:""===this._input?this.EOF:this.parseError("Lexical error on line "+(this.yylineno+1)+". Unrecognized text.\n"+this.showPosition(),{text:"",token:null,line:this.yylineno})},"next"),lex:(0,s.__name)(function(){var t=this.next();return t||this.lex()},"lex"),begin:(0,s.__name)(function(t){this.conditionStack.push(t)},"begin"),popState:(0,s.__name)(function(){return this.conditionStack.length-1>0?this.conditionStack.pop():this.conditionStack[0]},"popState"),_currentRules:(0,s.__name)(function(){return this.conditionStack.length&&this.conditionStack[this.conditionStack.length-1]?this.conditions[this.conditionStack[this.conditionStack.length-1]].rules:this.conditions.INITIAL.rules},"_currentRules"),topState:(0,s.__name)(function(t){return(t=this.conditionStack.length-1-Math.abs(t||0))>=0?this.conditionStack[t]:"INITIAL"},"topState"),pushState:(0,s.__name)(function(t){this.begin(t)},"pushState"),stateStackSize:(0,s.__name)(function(){return this.conditionStack.length},"stateStackSize"),options:{"case-insensitive":!0},performAction:(0,s.__name)(function(t,e,i,n){switch(i){case 0:return this.begin("open_directive"),"open_directive";case 1:return this.begin("acc_title"),31;case 2:return this.popState(),"acc_title_value";case 3:return this.begin("acc_descr"),33;case 4:return this.popState(),"acc_descr_value";case 5:this.begin("acc_descr_multiline");break;case 6:case 15:case 18:case 21:case 24:this.popState();break;case 7:return"acc_descr_multiline_value";case 8:case 9:case 10:case 12:case 13:break;case 11:return 10;case 14:this.begin("href");break;case 16:return 43;case 17:this.begin("callbackname");break;case 19:this.popState(),this.begin("callbackargs");break;case 20:return 41;case 22:return 42;case 23:this.begin("click");break;case 25:return 40;case 26:return 4;case 27:return 22;case 28:return 23;case 29:return 24;case 30:return 25;case 31:return 26;case 32:return 28;case 33:return 27;case 34:return 29;case 35:return 12;case 36:return 13;case 37:return 14;case 38:return 15;case 39:return 16;case 40:return 17;case 41:return 18;case 42:return 20;case 43:return 21;case 44:return"date";case 45:return 30;case 46:return"accDescription";case 47:return 36;case 48:return 38;case 49:return 39;case 50:return":";case 51:return 6;case 52:return"INVALID"}},"anonymous"),rules:[/^(?:%%\{)/i,/^(?:accTitle\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*\{\s*)/i,/^(?:[\}])/i,/^(?:[^\}]*)/i,/^(?:%%(?!\{)*[^\n]*)/i,/^(?:[^\}]%%*[^\n]*)/i,/^(?:%%*[^\n]*[\n]*)/i,/^(?:[\n]+)/i,/^(?:\s+)/i,/^(?:%[^\n]*)/i,/^(?:href[\s]+["])/i,/^(?:["])/i,/^(?:[^"]*)/i,/^(?:call[\s]+)/i,/^(?:\([\s]*\))/i,/^(?:\()/i,/^(?:[^(]*)/i,/^(?:\))/i,/^(?:[^)]*)/i,/^(?:click[\s]+)/i,/^(?:[\s\n])/i,/^(?:[^\s\n]*)/i,/^(?:gantt\b)/i,/^(?:dateFormat\s[^#\n;]+)/i,/^(?:inclusiveEndDates\b)/i,/^(?:topAxis\b)/i,/^(?:axisFormat\s[^#\n;]+)/i,/^(?:tickInterval\s[^#\n;]+)/i,/^(?:includes\s[^#\n;]+)/i,/^(?:excludes\s[^#\n;]+)/i,/^(?:todayMarker\s[^\n;]+)/i,/^(?:weekday\s+monday\b)/i,/^(?:weekday\s+tuesday\b)/i,/^(?:weekday\s+wednesday\b)/i,/^(?:weekday\s+thursday\b)/i,/^(?:weekday\s+friday\b)/i,/^(?:weekday\s+saturday\b)/i,/^(?:weekday\s+sunday\b)/i,/^(?:weekend\s+friday\b)/i,/^(?:weekend\s+saturday\b)/i,/^(?:\d\d\d\d-\d\d-\d\d\b)/i,/^(?:title\s[^\n]+)/i,/^(?:accDescription\s[^#\n;]+)/i,/^(?:section\s[^\n]+)/i,/^(?:[^:\n]+)/i,/^(?::[^#\n;]+)/i,/^(?::)/i,/^(?:$)/i,/^(?:.)/i],conditions:{acc_descr_multiline:{rules:[6,7],inclusive:!1},acc_descr:{rules:[4],inclusive:!1},acc_title:{rules:[2],inclusive:!1},callbackargs:{rules:[21,22],inclusive:!1},callbackname:{rules:[18,19,20],inclusive:!1},href:{rules:[15,16],inclusive:!1},click:{rules:[24,25],inclusive:!1},INITIAL:{rules:[0,1,3,5,8,9,10,11,12,13,14,17,23,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52],inclusive:!0}}},(0,s.__name)(S,"Parser"),S.prototype=C,C.Parser=S,new S}();C.parser=C,c.default.extend(l.default),c.default.extend(d.default),c.default.extend(u.default);var S={friday:5,saturday:6},M="",E="",A=void 0,Y="",L=[],I=[],O=new Map,F=[],W=[],P="",z="",B=["active","done","crit","milestone","vert"],H=[],N=!1,G=!1,j="sunday",R="saturday",U=0,V=(0,s.__name)(function(){F=[],W=[],P="",H=[],tD=0,e=void 0,i=void 0,tM=[],M="",E="",z="",A=void 0,Y="",L=[],I=[],N=!1,G=!1,U=0,O=new Map,(0,r.clear)(),j="sunday",R="saturday"},"clear"),Z=(0,s.__name)(function(t){E=t},"setAxisFormat"),q=(0,s.__name)(function(){return E},"getAxisFormat"),X=(0,s.__name)(function(t){A=t},"setTickInterval"),Q=(0,s.__name)(function(){return A},"getTickInterval"),K=(0,s.__name)(function(t){Y=t},"setTodayMarker"),J=(0,s.__name)(function(){return Y},"getTodayMarker"),tt=(0,s.__name)(function(t){M=t},"setDateFormat"),te=(0,s.__name)(function(){N=!0},"enableInclusiveEndDates"),ti=(0,s.__name)(function(){return N},"endDatesAreInclusive"),tn=(0,s.__name)(function(){G=!0},"enableTopAxis"),ta=(0,s.__name)(function(){return G},"topAxisEnabled"),tr=(0,s.__name)(function(t){z=t},"setDisplayMode"),ts=(0,s.__name)(function(){return z},"getDisplayMode"),to=(0,s.__name)(function(){return M},"getDateFormat"),tc=(0,s.__name)(function(t){L=t.toLowerCase().split(/[\s,]+/)},"setIncludes"),tl=(0,s.__name)(function(){return L},"getIncludes"),td=(0,s.__name)(function(t){I=t.toLowerCase().split(/[\s,]+/)},"setExcludes"),tu=(0,s.__name)(function(){return I},"getExcludes"),th=(0,s.__name)(function(){return O},"getLinks"),tf=(0,s.__name)(function(t){P=t,F.push(t)},"addSection"),tm=(0,s.__name)(function(){return F},"getSections"),ty=(0,s.__name)(function(){let t=tI(),e=0;for(;!t&&e<10;)t=tI(),e++;return W=tM},"getTasks"),tk=(0,s.__name)(function(t,e,i,n){let a=t.format(e.trim()),r=t.format("YYYY-MM-DD");return!(n.includes(a)||n.includes(r))&&(!!(i.includes("weekends")&&(t.isoWeekday()===S[R]||t.isoWeekday()===S[R]+1)||i.includes(t.format("dddd").toLowerCase()))||i.includes(a)||i.includes(r))},"isInvalidDate"),tg=(0,s.__name)(function(t){j=t},"setWeekday"),tp=(0,s.__name)(function(){return j},"getWeekday"),t_=(0,s.__name)(function(t){R=t},"setWeekend"),tb=(0,s.__name)(function(t,e,i,n){let a;if(!i.length||t.manualEndTime)return;let[r,s]=tT(a=(a=t.startTime instanceof Date?(0,c.default)(t.startTime):(0,c.default)(t.startTime,e,!0)).add(1,"d"),t.endTime instanceof Date?(0,c.default)(t.endTime):(0,c.default)(t.endTime,e,!0),e,i,n);t.endTime=r.toDate(),t.renderEndTime=s},"checkTaskDates"),tT=(0,s.__name)(function(t,e,i,n,a){let r=!1,s=null;for(;t<=e;)r||(s=e.toDate()),(r=tk(t,i,n,a))&&(e=e.add(1,"d")),t=t.add(1,"d");return[e,s]},"fixTaskDates"),tv=(0,s.__name)(function(t,e,i){if(i=i.trim(),("x"===e.trim()||"X"===e.trim())&&/^\d+$/.test(i))return new Date(Number(i));let n=/^after\s+(?<ids>[\d\w- ]+)/.exec(i);if(null!==n){let t=null;for(let e of n.groups.ids.split(" ")){let i=tY(e);void 0!==i&&(!t||i.endTime>t.endTime)&&(t=i)}if(t)return t.endTime;let e=new Date;return e.setHours(0,0,0,0),e}let a=(0,c.default)(i,e.trim(),!0);if(a.isValid())return a.toDate();{s.log.debug("Invalid date:"+i),s.log.debug("With date format:"+e.trim());let t=new Date(i);if(void 0===t||isNaN(t.getTime())||-1e4>t.getFullYear()||t.getFullYear()>1e4)throw Error("Invalid date:"+i);return t}},"getStartDate"),tx=(0,s.__name)(function(t){let e=/^(\d+(?:\.\d+)?)([Mdhmswy]|ms)$/.exec(t.trim());return null!==e?[Number.parseFloat(e[1]),e[2]]:[NaN,"ms"]},"parseDuration"),tw=(0,s.__name)(function(t,e,i,n=!1){i=i.trim();let a=/^until\s+(?<ids>[\d\w- ]+)/.exec(i);if(null!==a){let t=null;for(let e of a.groups.ids.split(" ")){let i=tY(e);void 0!==i&&(!t||i.startTime<t.startTime)&&(t=i)}if(t)return t.startTime;let e=new Date;return e.setHours(0,0,0,0),e}let r=(0,c.default)(i,e.trim(),!0);if(r.isValid())return n&&(r=r.add(1,"d")),r.toDate();let s=(0,c.default)(t),[o,l]=tx(i);if(!Number.isNaN(o)){let t=s.add(o,l);t.isValid()&&(s=t)}return s.toDate()},"getEndDate"),tD=0,t$=(0,s.__name)(function(t){return void 0===t?"task"+(tD+=1):t},"parseId"),tC=(0,s.__name)(function(t,e){let i=(":"===e.substr(0,1)?e.substr(1,e.length):e).split(","),n={};tN(i,n,B);for(let t=0;t<i.length;t++)i[t]=i[t].trim();let a="";switch(i.length){case 1:n.id=t$(),n.startTime=t.endTime,a=i[0];break;case 2:n.id=t$(),n.startTime=tv(void 0,M,i[0]),a=i[1];break;case 3:n.id=t$(i[0]),n.startTime=tv(void 0,M,i[1]),a=i[2]}return a&&(n.endTime=tw(n.startTime,M,a,N),n.manualEndTime=(0,c.default)(a,"YYYY-MM-DD",!0).isValid(),tb(n,M,I,L)),n},"compileData"),tS=(0,s.__name)(function(t,e){let i=(":"===e.substr(0,1)?e.substr(1,e.length):e).split(","),n={};tN(i,n,B);for(let t=0;t<i.length;t++)i[t]=i[t].trim();switch(i.length){case 1:n.id=t$(),n.startTime={type:"prevTaskEnd",id:t},n.endTime={data:i[0]};break;case 2:n.id=t$(),n.startTime={type:"getStartDate",startData:i[0]},n.endTime={data:i[1]};break;case 3:n.id=t$(i[0]),n.startTime={type:"getStartDate",startData:i[1]},n.endTime={data:i[2]}}return n},"parseData"),tM=[],tE={},tA=(0,s.__name)(function(t,e){let n={section:P,type:P,processed:!1,manualEndTime:!1,renderEndTime:null,raw:{data:e},task:t,classes:[]},a=tS(i,e);n.raw.startTime=a.startTime,n.raw.endTime=a.endTime,n.id=a.id,n.prevTaskId=i,n.active=a.active,n.done=a.done,n.crit=a.crit,n.milestone=a.milestone,n.vert=a.vert,n.order=U,U++;let r=tM.push(n);i=n.id,tE[n.id]=r-1},"addTask"),tY=(0,s.__name)(function(t){return tM[tE[t]]},"findTaskById"),tL=(0,s.__name)(function(t,i){let n={section:P,type:P,description:t,task:t,classes:[]},a=tC(e,i);n.startTime=a.startTime,n.endTime=a.endTime,n.id=a.id,n.active=a.active,n.done=a.done,n.crit=a.crit,n.milestone=a.milestone,n.vert=a.vert,e=n,W.push(n)},"addTaskOrg"),tI=(0,s.__name)(function(){let t=(0,s.__name)(function(t){let e=tM[t],i="";switch(tM[t].raw.startTime.type){case"prevTaskEnd":{let t=tY(e.prevTaskId);e.startTime=t.endTime;break}case"getStartDate":(i=tv(void 0,M,tM[t].raw.startTime.startData))&&(tM[t].startTime=i)}return tM[t].startTime&&(tM[t].endTime=tw(tM[t].startTime,M,tM[t].raw.endTime.data,N),tM[t].endTime&&(tM[t].processed=!0,tM[t].manualEndTime=(0,c.default)(tM[t].raw.endTime.data,"YYYY-MM-DD",!0).isValid(),tb(tM[t],M,I,L))),tM[t].processed},"compileTask"),e=!0;for(let[i,n]of tM.entries())t(i),e=e&&n.processed;return e},"compileTasks"),tO=(0,s.__name)(function(t,e){let i=e;"loose"!==(0,r.getConfig2)().securityLevel&&(i=(0,o.sanitizeUrl)(e)),t.split(",").forEach(function(t){void 0!==tY(t)&&(tP(t,()=>{window.open(i,"_self")}),O.set(t,i))}),tF(t,"clickable")},"setLink"),tF=(0,s.__name)(function(t,e){t.split(",").forEach(function(t){let i=tY(t);void 0!==i&&i.classes.push(e)})},"setClass"),tW=(0,s.__name)(function(t,e,i){if("loose"!==(0,r.getConfig2)().securityLevel||void 0===e)return;let n=[];if("string"==typeof i){n=i.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);for(let t=0;t<n.length;t++){let e=n[t].trim();e.startsWith('"')&&e.endsWith('"')&&(e=e.substr(1,e.length-2)),n[t]=e}}0===n.length&&n.push(t),void 0!==tY(t)&&tP(t,()=>{a.utils_default.runFunc(e,...n)})},"setClickFun"),tP=(0,s.__name)(function(t,e){H.push(function(){let i=document.querySelector(`[id="${t}"]`);null!==i&&i.addEventListener("click",function(){e()})},function(){let i=document.querySelector(`[id="${t}-text"]`);null!==i&&i.addEventListener("click",function(){e()})})},"pushFun"),tz=(0,s.__name)(function(t,e,i){t.split(",").forEach(function(t){tW(t,e,i)}),tF(t,"clickable")},"setClickEvent"),tB=(0,s.__name)(function(t){H.forEach(function(e){e(t)})},"bindFunctions"),tH={getConfig:(0,s.__name)(()=>(0,r.getConfig2)().gantt,"getConfig"),clear:V,setDateFormat:tt,getDateFormat:to,enableInclusiveEndDates:te,endDatesAreInclusive:ti,enableTopAxis:tn,topAxisEnabled:ta,setAxisFormat:Z,getAxisFormat:q,setTickInterval:X,getTickInterval:Q,setTodayMarker:K,getTodayMarker:J,setAccTitle:r.setAccTitle,getAccTitle:r.getAccTitle,setDiagramTitle:r.setDiagramTitle,getDiagramTitle:r.getDiagramTitle,setDisplayMode:tr,getDisplayMode:ts,setAccDescription:r.setAccDescription,getAccDescription:r.getAccDescription,addSection:tf,getSections:tm,getTasks:ty,addTask:tA,findTaskById:tY,addTaskOrg:tL,setIncludes:tc,getIncludes:tl,setExcludes:td,getExcludes:tu,setClickEvent:tz,setLink:tO,getLinks:th,bindFunctions:tB,parseDuration:tx,isInvalidDate:tk,setWeekday:tg,getWeekday:tp,setWeekend:t_};function tN(t,e,i){let n=!0;for(;n;)n=!1,i.forEach(function(i){let a=RegExp("^\\s*"+i+"\\s*$");t[0].match(a)&&(e[i]=!0,t.shift(1),n=!0)})}(0,s.__name)(tN,"getTaskTags");var tG=(0,s.__name)(function(){s.log.debug("Something is calling, setConf, remove the call")},"setConf"),tj={monday:D.timeMonday,tuesday:D.timeTuesday,wednesday:D.timeWednesday,thursday:D.timeThursday,friday:D.timeFriday,saturday:D.timeSaturday,sunday:D.timeSunday},tR=(0,s.__name)((t,e)=>{let i=[...t].map(()=>-1/0),n=[...t].sort((t,e)=>t.startTime-e.startTime||t.order-e.order),a=0;for(let t of n)for(let n=0;n<i.length;n++)if(t.startTime>=i[n]){i[n]=t.endTime,t.order=n+e,n>a&&(a=n);break}return a},"getMaxIntersections"),tU={parser:C,db:tH,renderer:{setConf:tG,draw:(0,s.__name)(function(t,e,i,a){let o,l=(0,r.getConfig2)().gantt,d=(0,r.getConfig2)().securityLevel;"sandbox"===d&&(o=(0,h.select)("#i"+e));let u="sandbox"===d?(0,h.select)(o.nodes()[0].contentDocument.body):(0,h.select)("body"),D="sandbox"===d?o.nodes()[0].contentDocument:document,C=D.getElementById(e);void 0===(n=C.parentElement.offsetWidth)&&(n=1200),void 0!==l.useWidth&&(n=l.useWidth);let S=a.db.getTasks(),M=[];for(let t of S)M.push(t.type);M=H(M);let E={},A=2*l.topPadding;if("compact"===a.db.getDisplayMode()||"compact"===l.displayMode){let t={};for(let e of S)void 0===t[e.section]?t[e.section]=[e]:t[e.section].push(e);let e=0;for(let i of Object.keys(t)){let n=tR(t[i],e)+1;e+=n,A+=n*(l.barHeight+l.barGap),E[i]=n}}else for(let t of(A+=S.length*(l.barHeight+l.barGap),M))E[t]=S.filter(e=>e.type===t).length;C.setAttribute("viewBox","0 0 "+n+" "+A);let Y=u.select(`[id="${e}"]`),L=(0,f.scaleTime)().domain([(0,m.min)(S,function(t){return t.startTime}),(0,y.max)(S,function(t){return t.endTime})]).rangeRound([0,n-l.leftPadding-l.rightPadding]);function I(t,e){let i=t.startTime,n=e.startTime,a=0;return i>n?a=1:i<n&&(a=-1),a}function O(t,e,i){let n=l.barHeight,r=n+l.barGap,s=l.topPadding,o=l.leftPadding,c=(0,k.scaleLinear)().domain([0,M.length]).range(["#00B9FA","#F95002"]).interpolate(g.interpolateHcl);W(r,s,o,e,i,t,a.db.getExcludes(),a.db.getIncludes()),P(o,s,e,i),F(t,r,s,o,n,c,e,i),z(r,s,o,n,c),B(o,s,e,i)}function F(t,i,n,s,o,c,d){t.sort((t,e)=>t.vert===e.vert?0:t.vert?1:-1);let u=[...new Set(t.map(t=>t.order))].map(e=>t.find(t=>t.order===e));Y.append("g").selectAll("rect").data(u).enter().append("rect").attr("x",0).attr("y",function(t,e){return t.order*i+n-2}).attr("width",function(){return d-l.rightPadding/2}).attr("height",i).attr("class",function(t){for(let[e,i]of M.entries())if(t.type===i)return"section section"+e%l.numberSectionStyles;return"section section0"}).enter();let f=Y.append("g").selectAll("rect").data(t).enter(),m=a.db.getLinks();if(f.append("rect").attr("id",function(t){return t.id}).attr("rx",3).attr("ry",3).attr("x",function(t){return t.milestone?L(t.startTime)+s+.5*(L(t.endTime)-L(t.startTime))-.5*o:L(t.startTime)+s}).attr("y",function(t,e){return(e=t.order,t.vert)?l.gridLineStartPadding:e*i+n}).attr("width",function(t){return t.milestone?o:t.vert?.08*o:L(t.renderEndTime||t.endTime)-L(t.startTime)}).attr("height",function(t){return t.vert?S.length*(l.barHeight+l.barGap)+2*l.barHeight:o}).attr("transform-origin",function(t,e){return e=t.order,(L(t.startTime)+s+.5*(L(t.endTime)-L(t.startTime))).toString()+"px "+(e*i+n+.5*o).toString()+"px"}).attr("class",function(t){let e="";t.classes.length>0&&(e=t.classes.join(" "));let i=0;for(let[e,n]of M.entries())t.type===n&&(i=e%l.numberSectionStyles);let n="";return t.active?t.crit?n+=" activeCrit":n=" active":t.done?n=t.crit?" doneCrit":" done":t.crit&&(n+=" crit"),0===n.length&&(n=" task"),t.milestone&&(n=" milestone "+n),t.vert&&(n=" vert "+n),n+=i,"task"+(n+=" "+e)}),f.append("text").attr("id",function(t){return t.id+"-text"}).text(function(t){return t.task}).attr("font-size",l.fontSize).attr("x",function(t){let e=L(t.startTime),i=L(t.renderEndTime||t.endTime);if(t.milestone&&(e+=.5*(L(t.endTime)-L(t.startTime))-.5*o,i=e+o),t.vert)return L(t.startTime)+s;let n=this.getBBox().width;return n>i-e?i+n+1.5*l.leftPadding>d?e+s-5:i+s+5:(i-e)/2+e+s}).attr("y",function(t,e){return t.vert?l.gridLineStartPadding+S.length*(l.barHeight+l.barGap)+60:t.order*i+l.barHeight/2+(l.fontSize/2-2)+n}).attr("text-height",o).attr("class",function(t){let e=L(t.startTime),i=L(t.endTime);t.milestone&&(i=e+o);let n=this.getBBox().width,a="";t.classes.length>0&&(a=t.classes.join(" "));let r=0;for(let[e,i]of M.entries())t.type===i&&(r=e%l.numberSectionStyles);let s="";return(t.active&&(s=t.crit?"activeCritText"+r:"activeText"+r),t.done?s=t.crit?s+" doneCritText"+r:s+" doneText"+r:t.crit&&(s=s+" critText"+r),t.milestone&&(s+=" milestoneText"),t.vert&&(s+=" vertText"),n>i-e)?i+n+1.5*l.leftPadding>d?a+" taskTextOutsideLeft taskTextOutside"+r+" "+s:a+" taskTextOutsideRight taskTextOutside"+r+" "+s+" width-"+n:a+" taskText taskText"+r+" "+s+" width-"+n}),"sandbox"===(0,r.getConfig2)().securityLevel){let t=(0,h.select)("#i"+e).nodes()[0].contentDocument;f.filter(function(t){return m.has(t.id)}).each(function(e){var i=t.querySelector("#"+e.id),n=t.querySelector("#"+e.id+"-text");let a=i.parentNode;var r=t.createElement("a");r.setAttribute("xlink:href",m.get(e.id)),r.setAttribute("target","_top"),a.appendChild(r),r.appendChild(i),r.appendChild(n)})}}function W(t,e,i,n,r,o,d,u){let h,f;if(0===d.length&&0===u.length)return;for(let{startTime:t,endTime:e}of o)(void 0===h||t<h)&&(h=t),(void 0===f||e>f)&&(f=e);if(!h||!f)return;if((0,c.default)(f).diff((0,c.default)(h),"year")>5)return void s.log.warn("The difference between the min and max time is more than 5 years. This will cause performance issues. Skipping drawing exclude days.");let m=a.db.getDateFormat(),y=[],k=null,g=(0,c.default)(h);for(;g.valueOf()<=f;)a.db.isInvalidDate(g,m,d,u)?k?k.end=g:k={start:g,end:g}:k&&(y.push(k),k=null),g=g.add(1,"d");Y.append("g").selectAll("rect").data(y).enter().append("rect").attr("id",t=>"exclude-"+t.start.format("YYYY-MM-DD")).attr("x",t=>L(t.start.startOf("day"))+i).attr("y",l.gridLineStartPadding).attr("width",t=>L(t.end.endOf("day"))-L(t.start.startOf("day"))).attr("height",r-e-l.gridLineStartPadding).attr("transform-origin",function(e,n){return(L(e.start)+i+.5*(L(e.end)-L(e.start))).toString()+"px "+(n*t+.5*r).toString()+"px"}).attr("class","exclude-range")}function P(t,e,i,n){let r,s=a.db.getDateFormat(),o=a.db.getAxisFormat();r=o||("D"===s?"%d":l.axisFormat??"%Y-%m-%d");let c=(0,p.axisBottom)(L).tickSize(-n+e+l.gridLineStartPadding).tickFormat((0,_.timeFormat)(r)),d=/^([1-9]\d*)(millisecond|second|minute|hour|day|week|month)$/.exec(a.db.getTickInterval()||l.tickInterval);if(null!==d){let t=d[1],e=d[2],i=a.db.getWeekday()||l.weekday;switch(e){case"millisecond":c.ticks(b.timeMillisecond.every(t));break;case"second":c.ticks(T.timeSecond.every(t));break;case"minute":c.ticks(v.timeMinute.every(t));break;case"hour":c.ticks(x.timeHour.every(t));break;case"day":c.ticks(w.timeDay.every(t));break;case"week":c.ticks(tj[i].every(t));break;case"month":c.ticks($.timeMonth.every(t))}}if(Y.append("g").attr("class","grid").attr("transform","translate("+t+", "+(n-50)+")").call(c).selectAll("text").style("text-anchor","middle").attr("fill","#000").attr("stroke","none").attr("font-size",10).attr("dy","1em"),a.db.topAxisEnabled()||l.topAxis){let i=(0,p.axisTop)(L).tickSize(-n+e+l.gridLineStartPadding).tickFormat((0,_.timeFormat)(r));if(null!==d){let t=d[1],e=d[2],n=a.db.getWeekday()||l.weekday;switch(e){case"millisecond":i.ticks(b.timeMillisecond.every(t));break;case"second":i.ticks(T.timeSecond.every(t));break;case"minute":i.ticks(v.timeMinute.every(t));break;case"hour":i.ticks(x.timeHour.every(t));break;case"day":i.ticks(w.timeDay.every(t));break;case"week":i.ticks(tj[n].every(t));break;case"month":i.ticks($.timeMonth.every(t))}}Y.append("g").attr("class","grid").attr("transform","translate("+t+", "+e+")").call(i).selectAll("text").style("text-anchor","middle").attr("fill","#000").attr("stroke","none").attr("font-size",10)}}function z(t,e){let i=0,n=Object.keys(E).map(t=>[t,E[t]]);Y.append("g").selectAll("text").data(n).enter().append(function(t){let e=t[0].split(r.common_default.lineBreakRegex),i=-(e.length-1)/2,n=D.createElementNS("http://www.w3.org/2000/svg","text");for(let[t,a]of(n.setAttribute("dy",i+"em"),e.entries())){let e=D.createElementNS("http://www.w3.org/2000/svg","tspan");e.setAttribute("alignment-baseline","central"),e.setAttribute("x","10"),t>0&&e.setAttribute("dy","1em"),e.textContent=a,n.appendChild(e)}return n}).attr("x",10).attr("y",function(a,r){if(!(r>0))return a[1]*t/2+e;for(let s=0;s<r;s++)return i+=n[r-1][1],a[1]*t/2+i*t+e}).attr("font-size",l.sectionFontSize).attr("class",function(t){for(let[e,i]of M.entries())if(t[0]===i)return"sectionTitle sectionTitle"+e%l.numberSectionStyles;return"sectionTitle"})}function B(t,e,i,n){let r=a.db.getTodayMarker();if("off"===r)return;let s=Y.append("g").attr("class","today"),o=new Date,c=s.append("line");c.attr("x1",L(o)+t).attr("x2",L(o)+t).attr("y1",l.titleTopMargin).attr("y2",n-l.titleTopMargin).attr("class","today"),""!==r&&c.attr("style",r.replace(/,/g,";"))}function H(t){let e={},i=[];for(let n=0,a=t.length;n<a;++n)Object.prototype.hasOwnProperty.call(e,t[n])||(e[t[n]]=!0,i.push(t[n]));return i}(0,s.__name)(I,"taskCompare"),S.sort(I),O(S,n,A),(0,r.configureSvgSize)(Y,A,n,l.useMaxWidth),Y.append("text").text(a.db.getDiagramTitle()).attr("x",n/2).attr("y",l.titleTopMargin).attr("class","titleText"),(0,s.__name)(O,"makeGantt"),(0,s.__name)(F,"drawRects"),(0,s.__name)(W,"drawExcludeDays"),(0,s.__name)(P,"makeGrid"),(0,s.__name)(z,"vertLabels"),(0,s.__name)(B,"drawToday"),(0,s.__name)(H,"checkUnique")},"draw")},styles:(0,s.__name)(t=>`
  .mermaid-main-font {
        font-family: ${t.fontFamily};
  }

  .exclude-range {
    fill: ${t.excludeBkgColor};
  }

  .section {
    stroke: none;
    opacity: 0.2;
  }

  .section0 {
    fill: ${t.sectionBkgColor};
  }

  .section2 {
    fill: ${t.sectionBkgColor2};
  }

  .section1,
  .section3 {
    fill: ${t.altSectionBkgColor};
    opacity: 0.2;
  }

  .sectionTitle0 {
    fill: ${t.titleColor};
  }

  .sectionTitle1 {
    fill: ${t.titleColor};
  }

  .sectionTitle2 {
    fill: ${t.titleColor};
  }

  .sectionTitle3 {
    fill: ${t.titleColor};
  }

  .sectionTitle {
    text-anchor: start;
    font-family: ${t.fontFamily};
  }


  /* Grid and axis */

  .grid .tick {
    stroke: ${t.gridColor};
    opacity: 0.8;
    shape-rendering: crispEdges;
  }

  .grid .tick text {
    font-family: ${t.fontFamily};
    fill: ${t.textColor};
  }

  .grid path {
    stroke-width: 0;
  }


  /* Today line */

  .today {
    fill: none;
    stroke: ${t.todayLineColor};
    stroke-width: 2px;
  }


  /* Task styling */

  /* Default task */

  .task {
    stroke-width: 2;
  }

  .taskText {
    text-anchor: middle;
    font-family: ${t.fontFamily};
  }

  .taskTextOutsideRight {
    fill: ${t.taskTextDarkColor};
    text-anchor: start;
    font-family: ${t.fontFamily};
  }

  .taskTextOutsideLeft {
    fill: ${t.taskTextDarkColor};
    text-anchor: end;
  }


  /* Special case clickable */

  .task.clickable {
    cursor: pointer;
  }

  .taskText.clickable {
    cursor: pointer;
    fill: ${t.taskTextClickableColor} !important;
    font-weight: bold;
  }

  .taskTextOutsideLeft.clickable {
    cursor: pointer;
    fill: ${t.taskTextClickableColor} !important;
    font-weight: bold;
  }

  .taskTextOutsideRight.clickable {
    cursor: pointer;
    fill: ${t.taskTextClickableColor} !important;
    font-weight: bold;
  }


  /* Specific task settings for the sections*/

  .taskText0,
  .taskText1,
  .taskText2,
  .taskText3 {
    fill: ${t.taskTextColor};
  }

  .task0,
  .task1,
  .task2,
  .task3 {
    fill: ${t.taskBkgColor};
    stroke: ${t.taskBorderColor};
  }

  .taskTextOutside0,
  .taskTextOutside2
  {
    fill: ${t.taskTextOutsideColor};
  }

  .taskTextOutside1,
  .taskTextOutside3 {
    fill: ${t.taskTextOutsideColor};
  }


  /* Active task */

  .active0,
  .active1,
  .active2,
  .active3 {
    fill: ${t.activeTaskBkgColor};
    stroke: ${t.activeTaskBorderColor};
  }

  .activeText0,
  .activeText1,
  .activeText2,
  .activeText3 {
    fill: ${t.taskTextDarkColor} !important;
  }


  /* Completed task */

  .done0,
  .done1,
  .done2,
  .done3 {
    stroke: ${t.doneTaskBorderColor};
    fill: ${t.doneTaskBkgColor};
    stroke-width: 2;
  }

  .doneText0,
  .doneText1,
  .doneText2,
  .doneText3 {
    fill: ${t.taskTextDarkColor} !important;
  }


  /* Tasks on the critical line */

  .crit0,
  .crit1,
  .crit2,
  .crit3 {
    stroke: ${t.critBorderColor};
    fill: ${t.critBkgColor};
    stroke-width: 2;
  }

  .activeCrit0,
  .activeCrit1,
  .activeCrit2,
  .activeCrit3 {
    stroke: ${t.critBorderColor};
    fill: ${t.activeTaskBkgColor};
    stroke-width: 2;
  }

  .doneCrit0,
  .doneCrit1,
  .doneCrit2,
  .doneCrit3 {
    stroke: ${t.critBorderColor};
    fill: ${t.doneTaskBkgColor};
    stroke-width: 2;
    cursor: pointer;
    shape-rendering: crispEdges;
  }

  .milestone {
    transform: rotate(45deg) scale(0.8,0.8);
  }

  .milestoneText {
    font-style: italic;
  }
  .doneCritText0,
  .doneCritText1,
  .doneCritText2,
  .doneCritText3 {
    fill: ${t.taskTextDarkColor} !important;
  }

  .vert {
    stroke: ${t.vertLineColor};
  }

  .vertText {
    font-size: 15px;
    text-anchor: middle;
    fill: ${t.vertLineColor} !important;
  }

  .activeCritText0,
  .activeCritText1,
  .activeCritText2,
  .activeCritText3 {
    fill: ${t.taskTextDarkColor} !important;
  }

  .titleText {
    text-anchor: middle;
    font-size: 18px;
    fill: ${t.titleColor||t.textColor};
    font-family: ${t.fontFamily};
  }
`,"getStyles")}}]);