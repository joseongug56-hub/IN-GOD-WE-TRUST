
// pages/StoryBiblePage.tsx
import React, { useState, useCallback } from 'react';
import { ScrollText, Sparkles, User, Map, Book, Settings, Save, Trash2, Plus, RefreshCw, Eye, EyeOff, Edit2, Check, X, SlidersHorizontal, RotateCcw, FileText, Download, Upload, Layers, Clock, Play, Square } from 'lucide-react';
import { useStoryBible } from '../hooks/useStoryBible';
import { useSettingsStore } from '../stores/settingsStore';
import { useTranslationStore } from '../stores/translationStore';
import { Button, Input, Textarea, IconButton, Slider, Checkbox, ProgressBar } from '../components';
import { DEFAULT_STORY_BIBLE_EXTRACTION_PROMPT } from '../types/config';

/**
 * 시간 포맷팅 유틸리티
 */
const formatTime = (seconds?: number) => {
  if (seconds === undefined || seconds < 0) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}분 ${secs.toString().padStart(2, '0')}초`;
};

/**
 * 인물 카드 컴포넌트
 */
const CharacterCard: React.FC<{ char: any; onUpdate: any; onRemove: any; onToggle: any }> = ({ char, onUpdate, onRemove, onToggle }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [edited, setEdited] = useState(char);

  const handleSave = () => { onUpdate(char.id, edited); setIsEditing(false); };

  return (
    <div className={`p-4 rounded-xl border-2 transition-all ${char.isActive ? 'bg-white border-primary-100 shadow-sm' : 'bg-gray-50 border-gray-200 opacity-60'}`}>
      <div className="flex justify-between items-start mb-3">
        <div className="flex-1">
          {isEditing ? (
            <Input value={edited.name} onChange={e => setEdited({...edited, name: e.target.value})} className="font-bold mb-1" />
          ) : (
            <h4 className="font-bold text-lg text-primary-900">{char.name}</h4>
          )}
          {isEditing ? (
            <Input value={edited.role} onChange={e => setEdited({...edited, role: e.target.value})} />
          ) : (
            <span className="text-xs bg-primary-100 text-primary-700 px-2 py-0.5 rounded-full font-medium">{char.role}</span>
          )}
        </div>
        <div className="flex gap-1">
          <IconButton size="sm" icon={char.isActive ? <Eye className="w-4 h-4"/> : <EyeOff className="w-4 h-4"/>} onClick={() => onToggle(char.id)} aria-label="토글" />
          {isEditing ? (
            <>
              <IconButton size="sm" icon={<Check className="w-4 h-4 text-green-600"/>} onClick={handleSave} aria-label="저장" />
              <IconButton size="sm" icon={<X className="w-4 h-4 text-red-600"/>} onClick={() => setIsEditing(false)} aria-label="취소" />
            </>
          ) : (
            <IconButton size="sm" icon={<Edit2 className="w-4 h-4"/>} onClick={() => setIsEditing(true)} aria-label="수정" />
          )}
          <IconButton size="sm" icon={<Trash2 className="w-4 h-4 text-red-400"/>} onClick={() => onRemove(char.id)} aria-label="삭제" />
        </div>
      </div>
      
      <div className="space-y-2 text-sm text-gray-600">
        <div>
          <label className="text-[10px] uppercase font-bold text-gray-400">성격 및 특징</label>
          {isEditing ? <Textarea rows={2} value={edited.personality} onChange={e => setEdited({...edited, personality: e.target.value})} /> : <p className="leading-snug">{char.personality}</p>}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] uppercase font-bold text-gray-400">말투</label>
            {isEditing ? <Input value={edited.speakingStyle} onChange={e => setEdited({...edited, speakingStyle: e.target.value})} /> : <p className="truncate font-medium text-blue-600">{char.speakingStyle}</p>}
          </div>
          <div>
            <label className="text-[10px] uppercase font-bold text-gray-400">관계</label>
            {isEditing ? <Input value={edited.relationships} onChange={e => setEdited({...edited, relationships: e.target.value})} /> : <p className="truncate">{char.relationships}</p>}
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * AI 추출 섹션 (상세 설정 및 진행 상황 포함)
 */
function ExtractionSection() {
  const { config, updateConfig } = useSettingsStore();
  const { inputFiles } = useTranslationStore();
  const { isExtracting, extractionProgress, executeExtraction, cancelExtraction, data, extractionQueue } = useStoryBible();
  
  const [isExpanded, setIsExpanded] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [useCustomText, setUseCustomText] = useState(false);
  const [incremental, setIncremental] = useState(true); 
  const [customText, setCustomText] = useState('');

  const handleExtract = useCallback(() => {
    // 새로 시작 (큐 무시)
    if (useCustomText && customText.trim()) {
      executeExtraction(customText, incremental, false);
    } else {
      executeExtraction(undefined, incremental, false);
    }
  }, [executeExtraction, useCustomText, customText, incremental]);

  const handleResume = useCallback(() => {
    // 이어하기 (큐 사용)
    executeExtraction(undefined, incremental, true);
  }, [executeExtraction, incremental]);

  const percentage = extractionProgress?.totalSteps
    ? Math.round((extractionProgress.processedSteps / extractionProgress.totalSteps) * 100)
    : 0;

  const canResume = extractionQueue.length > 0 && !isExtracting;

  return (
    <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-2xl p-6 mb-6 border border-blue-100 shadow-sm">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex justify-between items-center text-lg font-bold text-blue-900"
      >
        <span className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-blue-600" />
          AI 스토리 바이블 자동 추출 (소설 전체 범위 샘플링)
        </span>
        <span className="text-blue-400">{isExpanded ? '▲' : '▼'}</span>
      </button>

      {isExpanded && (
        <div className="mt-6 space-y-6 animate-fadeIn">
          <div className="flex flex-wrap items-center gap-6">
             <div className="flex items-center gap-2 p-2 bg-white rounded-lg border border-blue-200 shadow-sm">
                <Layers className="w-4 h-4 text-blue-500" />
                <Checkbox
                  label="기존 데이터 유지하며 업데이트 (증분 분석)"
                  checked={incremental}
                  onChange={e => setIncremental(e.target.checked)}
                  disabled={!data}
                />
             </div>
            <Checkbox
              label="사용자 정의 텍스트로 분석"
              checked={useCustomText}
              onChange={e => setUseCustomText(e.target.checked)}
              disabled={canResume}
            />
            {!useCustomText && (
              <span className="text-sm text-blue-600 flex items-center gap-1.5">
                <FileText className="w-4 h-4" />
                {inputFiles.length > 0 ? `${inputFiles.length}개의 업로드된 파일 분석` : '⚠️ 분석할 파일을 먼저 업로드하세요'}
              </span>
            )}
          </div>

          {canResume && (
            <div className="text-sm text-blue-700 bg-blue-100 p-3 rounded-lg border border-blue-200 flex items-center gap-2">
              <RefreshCw className="w-4 h-4" />
              이전 작업이 중단되었습니다. 남은 {extractionQueue.length}개 세그먼트부터 이어할 수 있습니다.
            </div>
          )}

          {incremental && data && !canResume && (
            <div className="text-xs text-blue-700 bg-blue-100/50 p-3 rounded-lg border border-blue-100 italic">
              * 소설 전체에서 무작위로 추출된 샘플들을 통해 기존에 등록된 {data.characters.length}명의 인물과 설정을 보완합니다.
            </div>
          )}

          {useCustomText && (
            <Textarea
              placeholder="배경 정보를 추출할 텍스트를 입력하세요. 입력된 텍스트 전체를 샘플링하여 분석합니다..."
              value={customText}
              onChange={e => setCustomText(e.target.value)}
              rows={6}
              className="bg-white/80"
            />
          )}

          {/* 진행 상황 브리핑 UI */}
          {isExtracting && extractionProgress && (
             <div className="p-5 bg-white border border-blue-100 rounded-xl shadow-sm space-y-4 animate-fadeIn">
                <div className="flex justify-between items-end">
                   <div className="space-y-1">
                      <p className="text-sm font-bold text-blue-900 flex items-center gap-2">
                         <RefreshCw className="w-4 h-4 animate-spin" />
                         {extractionProgress.currentStatusMessage}
                      </p>
                      <p className="text-xs text-blue-600">소설의 전반적인 맥락을 읽고 흩어진 설정 조각들을 모으는 중입니다...</p>
                   </div>
                   {extractionProgress.etaSeconds !== undefined && (
                      <div className="flex items-center gap-1.5 text-xs font-mono text-blue-700 bg-blue-50 px-2 py-1 rounded">
                         <Clock className="w-3 h-3" />
                         남은 예상 시간: {formatTime(extractionProgress.etaSeconds)}
                      </div>
                   )}
                </div>
                
                <ProgressBar
                   value={percentage}
                   showPercentage
                   color="primary"
                   height="md"
                   striped
                   animated
                   detail={`${extractionProgress.processedSteps}/${extractionProgress.totalSteps} 조각 분석 완료`}
                />
             </div>
          )}

          <div className="bg-white/50 rounded-xl p-4 border border-blue-100">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-sm font-semibold text-blue-700 hover:text-blue-900 transition-colors w-full"
            >
              <SlidersHorizontal className="w-4 h-4" />
              샘플링 및 분석 설정 (Global Sampling)
              <span className="text-xs text-blue-300 ml-auto">{showAdvanced ? '접기 ▲' : '펼치기 ▼'}</span>
            </button>

            {showAdvanced && (
              <div className="mt-4 space-y-5 animate-fadeIn">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <Slider
                      label={`전체 범위 샘플링 비율 (${config.storyBibleSamplingRatio}%)`}
                      value={config.storyBibleSamplingRatio}
                      min={1}
                      max={100}
                      onChange={e => updateConfig({ storyBibleSamplingRatio: parseInt(e.target.value) })}
                      helperText="소설 전체에서 얼마만큼의 비율을 무작위로 뽑아 분석할지 결정합니다."
                    />
                  </div>
                  <div>
                    <Input
                      type="number"
                      label="분석 단위 (Chunk Size)"
                      value={config.storyBibleChunkSize}
                      onChange={e => updateConfig({ storyBibleChunkSize: parseInt(e.target.value) || 30000 })}
                      min={5000}
                      step={5000}
                      helperText="한 번에 분석할 샘플의 크기입니다. 클수록 문맥 파악이 좋지만 비용이 증가합니다."
                    />
                  </div>
                  <div>
                    <Slider
                      label={`분석 온도 (${config.storyBibleExtractionTemperature})`}
                      value={config.storyBibleExtractionTemperature}
                      min={0}
                      max={1}
                      step={0.1}
                      onChange={e => updateConfig({ storyBibleExtractionTemperature: parseFloat(e.target.value) })}
                      helperText="낮을수록 사실적인 정보를, 높을수록 행간을 읽는 창의적인 분석을 수행합니다."
                    />
                  </div>
                </div>

                <Textarea
                  label="추출 프롬프트 커스텀"
                  value={config.storyBibleExtractionPrompt}
                  onChange={e => updateConfig({ storyBibleExtractionPrompt: e.target.value })}
                  rows={5}
                  className="text-xs font-mono"
                  helperText="{{existing_bible}} 및 {{glossary_context}} 변수가 자동으로 주입됩니다."
                />

                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => updateConfig({
                      storyBibleSamplingRatio: 15,
                      storyBibleChunkSize: 30000,
                      storyBibleExtractionTemperature: 0.2,
                      storyBibleExtractionPrompt: DEFAULT_STORY_BIBLE_EXTRACTION_PROMPT
                    })}
                    leftIcon={<RotateCcw className="w-3 h-3"/>}
                    className="text-blue-600 text-xs"
                  >
                    설정 초기화
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-4">
            {!isExtracting ? (
              <>
                {canResume && (
                  <Button
                    variant="primary"
                    size="lg"
                    onClick={handleResume}
                    leftIcon={<Play className="w-5 h-5" />}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    이어하기 ({extractionQueue.length}개 남음)
                  </Button>
                )}
                
                <Button
                  variant={canResume ? 'secondary' : 'primary'}
                  size="lg"
                  onClick={handleExtract}
                  disabled={(!useCustomText && inputFiles.length === 0)}
                  leftIcon={<Sparkles className="w-5 h-5" />}
                  className={canResume ? "" : "px-8 shadow-indigo-100 shadow-lg"}
                >
                  {canResume ? '초기화 후 다시 시작' : (incremental && data ? '글로벌 업데이트 시작' : '전체 범위 심층 분석')}
                </Button>
              </>
            ) : (
              <Button
                variant="danger"
                size="lg"
                onClick={cancelExtraction}
                leftIcon={<Square className="w-5 h-5" />}
              >
                분석 중지
              </Button>
            )}
            
            {isExtracting && <span className="text-sm text-blue-600 animate-pulse font-medium">소설 전체를 훑으며 조각난 설정들을 동기화하는 중...</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export function StoryBiblePage() {
  const { data, isExtracting, downloadBible, importBibleFile, updateGlobal, addCharacter, updateCharacter, removeCharacter, toggleCharacter, addWorldSetting, updateWorldSetting, removeWorldSetting, toggleWorldSetting, clear, extractionQueue } = useStoryBible();
  const [activeTab, setActiveTab] = useState<'chars' | 'world' | 'style'>('chars');

  if (!data && !isExtracting && extractionQueue.length === 0) {
    return (
      <div className="max-w-4xl mx-auto space-y-6 py-8">
        <div className="bg-white rounded-2xl shadow-xl p-16 text-center fade-in border border-gray-100">
          <div className="w-24 h-24 bg-primary-50 rounded-full flex items-center justify-center mx-auto mb-6">
            <ScrollText className="w-12 h-12 text-primary-500" />
          </div>
          <h2 className="text-2xl font-bold text-gray-800 mb-3">배경 정보가 비어있습니다</h2>
          <p className="text-gray-500 mb-8 leading-relaxed">
            나누어 번역하는 소설의 경우, 이전 작업에서 내보낸 스토리 바이블 파일을 불러오거나<br/>
            첫 번째 파일을 업로드하여 <strong>전체 범위 심층 분석</strong>을 시작하세요.
          </p>
          
          <div className="flex justify-center gap-3 mb-8">
             <Button variant="outline" leftIcon={<Upload className="w-4 h-4"/>} onClick={() => importBibleFile(false)}>파일에서 불러오기</Button>
          </div>

          <ExtractionSection />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 fade-in max-w-6xl mx-auto">
      <ExtractionSection />

      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 bg-gray-50 border-b border-gray-200 flex flex-wrap justify-between items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary-100 rounded-lg"><ScrollText className="w-5 h-5 text-primary-600" /></div>
            <h2 className="text-xl font-bold text-gray-800">어드밴스드 스토리 바이블 (Global Mode)</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={() => importBibleFile(true)} leftIcon={<Layers className="w-4 h-4" />}>기존에 합치기</Button>
            <Button variant="ghost" size="sm" onClick={() => importBibleFile(false)} leftIcon={<Upload className="w-4 h-4" />}>가져오기</Button>
            <Button variant="ghost" size="sm" onClick={downloadBible} leftIcon={<Download className="w-4 h-4" />}>내보내기</Button>
            <div className="w-px h-6 bg-gray-200 mx-1 hidden sm:block"></div>
            <Button variant="danger" size="sm" onClick={clear} leftIcon={<Trash2 className="w-4 h-4" />}>데이터 리셋</Button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b overflow-x-auto">
          {[
            { id: 'chars', label: '인물 도감', icon: <User className="w-4 h-4"/>, count: data?.characters.length },
            { id: 'world', label: '세계관 설정', icon: <Map className="w-4 h-4"/>, count: data?.worldSettings.length },
            { id: 'style', label: '줄거리 및 스타일', icon: <Book className="w-4 h-4"/> },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex-1 min-w-[120px] py-4 flex items-center justify-center gap-2 font-semibold transition-all border-b-2 ${activeTab === tab.id ? 'text-primary-600 border-primary-600 bg-primary-50/50' : 'text-gray-500 border-transparent hover:bg-gray-50'}`}
            >
              {tab.icon} {tab.label} {tab.count !== undefined && <span className="bg-gray-200 text-gray-600 text-[10px] px-1.5 py-0.5 rounded-full ml-1">{tab.count}</span>}
            </button>
          ))}
        </div>

        <div className="p-6">
          {isExtracting ? (
             <div className="py-20 text-center">
                <div className="spinner mx-auto mb-6 w-12 h-12 border-primary-500 border-t-transparent"></div>
                <p className="text-gray-500 animate-pulse font-medium">소설 전체 범위를 무작위 샘플링하여 도감을 동기화하는 중입니다...</p>
             </div>
          ) : (
            <>
              {activeTab === 'chars' && (
                <div className="space-y-4 animate-fadeIn">
                  <div className="flex justify-between items-center">
                    <h3 className="font-bold text-gray-700 flex items-center gap-2"><User className="w-4 h-4" /> 주요 등장인물 리스트</h3>
                    <Button size="sm" variant="ghost" onClick={() => addCharacter({ name: '새 인물', role: '역할', personality: '', speakingStyle: '', relationships: '', notes: '' })} leftIcon={<Plus className="w-4 h-4"/>}>인물 추가</Button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {data?.characters.map(char => (
                      <CharacterCard key={char.id} char={char} onUpdate={updateCharacter} onRemove={removeCharacter} onToggle={toggleCharacter} />
                    ))}
                  </div>
                </div>
              )}

              {activeTab === 'world' && (
                <div className="space-y-4 animate-fadeIn">
                  <div className="flex justify-between items-center">
                    <h3 className="font-bold text-gray-700 flex items-center gap-2"><Map className="w-4 h-4" /> 세계관 및 고유 설정</h3>
                    <Button size="sm" variant="ghost" onClick={() => addWorldSetting({ category: '일반', title: '새 설정', content: '' })} leftIcon={<Plus className="w-4 h-4"/>}>설정 추가</Button>
                  </div>
                  <div className="space-y-3">
                    {data?.worldSettings.map(w => (
                      <div key={w.id} className={`p-4 rounded-xl border-2 flex gap-4 items-start transition-all ${w.isActive ? 'bg-white border-gray-100 shadow-sm' : 'bg-gray-50 border-gray-100 opacity-60'}`}>
                        <IconButton icon={w.isActive ? <Eye className="w-4 h-4"/> : <EyeOff className="w-4 h-4"/>} onClick={() => toggleWorldSetting(w.id)} aria-label="토글" />
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] font-bold text-primary-600 bg-primary-50 px-1.5 py-0.5 rounded uppercase tracking-tighter">{w.category}</span>
                            <input className="font-bold text-gray-800 bg-transparent border-none focus:ring-0 p-0 w-full" value={w.title} onChange={e => updateWorldSetting(w.id, { title: e.target.value })} />
                          </div>
                          <textarea className="w-full text-sm text-gray-600 bg-transparent border-none focus:ring-0 p-0 resize-none font-sans leading-relaxed" rows={2} value={w.content} onChange={e => updateWorldSetting(w.id, { content: e.target.value })} />
                        </div>
                        <IconButton icon={<Trash2 className="w-4 h-4 text-red-400"/>} onClick={() => removeWorldSetting(w.id)} aria-label="삭제" />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeTab === 'style' && (
                <div className="space-y-6 animate-fadeIn">
                  <div className="space-y-2">
                    <h3 className="font-bold text-gray-700 flex items-center gap-2 border-b pb-2"><Book className="w-4 h-4" /> 스토리 타임라인 (샘플링 결과)</h3>
                    <Textarea rows={8} value={data?.plotSummary} onChange={e => updateGlobal({ plotSummary: e.target.value })} placeholder="현재까지의 진행 상황을 입력하거나 AI가 분석한 결과를 확인하세요..." />
                  </div>
                  <div className="space-y-2">
                    <h3 className="font-bold text-gray-700 flex items-center gap-2 border-b pb-2"><Settings className="w-4 h-4" /> 번역 스타일 가이드</h3>
                    <Textarea rows={6} value={data?.styleGuide} onChange={e => updateGlobal({ styleGuide: e.target.value })} placeholder="문체, 호칭 등 세부 지침을 입력하세요..." />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      
      <div className="p-4 bg-indigo-50 rounded-xl border border-indigo-100 text-sm text-indigo-800 flex gap-3 shadow-inner">
        <Sparkles className="w-5 h-5 flex-shrink-0 text-indigo-500" />
        <p className="leading-relaxed">
          <strong>글로벌 샘플링의 위력:</strong> 이제 AI가 소설의 맨 앞부분만 보는 것이 아니라, 무작위로 추출된 <strong>전체 범위</strong>를 훑습니다. 
          이를 통해 중후반부에 등장하는 새로운 인물이나 급변하는 세계관 설정까지 미리 파악하여 완벽한 번역 준비를 마칠 수 있습니다.
        </p>
      </div>
    </div>
  );
}
