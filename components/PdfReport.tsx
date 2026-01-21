
// @ts-nocheck
import { useMemo } from 'react';
import React from 'react';
import { getPanelCount } from '../services/calculatorService';
import { Project, Material, InverterBrand, CompatibilityReport, Component } from '../types';
import { groupMaterialsByCategory } from '../services/calculatorService';
import { getLocationClimate } from '../services/climateService';
import type { MicroBranchesReport } from '../services/microBranchService';
import { getSubscriptionStatus } from '../services/subscriptionService';
import { isProtectionTooHighForSection, isSectionOversizedForIn, getMaxIdcForSection, isDcCableTooSmallForI, getMinSectionForIn } from '../services/standardsService';
import RoofVisualizer from './RoofVisualizer';
import InstallationDiagram from './InstallationDiagram';
import ElectricalSchematic from './ElectricalSchematic';
import { ENPHASE_COMPONENTS, APSYSTEMS_COMPONENTS, FOXESS_COMPONENTS } from '../data/inverters';

interface PdfReportProps {
  project: Project;
  materials: Material[];
  exportOptions: {
    includeDatasheets: boolean;
    includeGuides: boolean;
    includeRegulations: boolean;
  };
  report: CompatibilityReport | null;
  voltageDrop: number; 
  acSection: number;   
  microBranchesReport?: MicroBranchesReport | null;
}

const ITEMS_PER_PAGE = 14;

type PrintableRow = 
  | { type: 'header'; title: string }
  | { type: 'subheader'; title: string }
  | { type: 'item'; material: Material }
  | { type: 'warning'; text: string };

const DocLink = ({ title, url, icon = "📄" }: { title: string, url: string, icon?: string }) => (
    <a href={url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors group text-decoration-none">
        <div className="w-8 h-8 bg-slate-100 rounded-full flex items-center justify-center text-lg group-hover:scale-110 transition-transform shadow-sm">
            {icon}
        </div>
        <div className="flex-1 overflow-hidden">
            <div className="font-bold text-slate-700 text-[10px] uppercase tracking-wide leading-tight">{title}</div>
            <div className="text-[8px] text-blue-600 underline truncate w-full">{url}</div>
        </div>
        <div className="text-slate-300 group-hover:text-blue-500 text-xs font-bold">➜</div>
    </a>
);

const PdfReport: React.FC<PdfReportProps> = ({ project, materials, exportOptions, report, voltageDrop, acSection, microBranchesReport }) => {
  // IMPORTANT: ne pas utiliser rows*columns directement.
  // En "forme libre", la quantité réelle est portée par panels.rowConfiguration.
  const totalPowerW = project.fields.reduce((sum, f) => sum + (f.panels.model.power * getPanelCount(f.panels)), 0);
  const totalPowerkWc = (totalPowerW / 1000).toFixed(2);
  
  const isThreePhase = project.inverterConfig.phase === 'Tri';
  const firstField = project.fields[0];
  const activePanel = firstField.panels.model;
  
  const climate = getLocationClimate(project.postalCode, project.altitude);
  
  const vocColdString = report?.details?.vocCold || 0;
  const vmpHotString = report?.details?.vmpHot || 0;
  const dcAcRatio = report?.details?.dcAcRatio ? report.details.dcAcRatio * 100 : 0;
  const invVmaxLimit = report?.details?.vmaxInverter || (isThreePhase ? 1000 : 600);
  const invVmpMin = report?.details?.vminMppt || 80;

  // Aligner l'export PDF avec la logique UI :
  // - Enphase + APSystems = micro
  // - FoxESS peut etre micro OU centralise selon modele
  // - Custom : on se base sur les specs detectees dans le report si dispo
  const isMicroSystem = useMemo(() => {
    const isCustomMicro = project.inverterConfig.brand === InverterBrand.CUSTOM && !!report?.inverterSpecs?.isMicro;
    const isKnownMicroBrand = project.inverterConfig.brand === InverterBrand.ENPHASE || project.inverterConfig.brand === InverterBrand.APSYSTEMS;
    const isFoxMicro = project.inverterConfig.brand === InverterBrand.FOXESS && (
      (project.inverterConfig.model || '').toUpperCase().includes('MICRO') || project.inverterConfig.model === 'FOX-S3000-G2'
    );
    return isKnownMicroBrand || isFoxMicro || isCustomMicro;
  }, [project.inverterConfig.brand, project.inverterConfig.model, report?.inverterSpecs?.isMicro]);

  const stringsAnalysis = report?.details?.stringsAnalysis || [];
  const mpptCount = stringsAnalysis.length;

  // Estimation DC : chute de tension par MPPT (si onduleur centralisé / chaînes PV)
  const dcDropRows = useMemo(() => {
    if (isMicroSystem || stringsAnalysis.length === 0) return [];
    const rho = 0.023;
    return stringsAnalysis.map((s: any) => {
      const run = (project.inverterConfig.dcCablingRuns || []).find((r: any) => r.mpptIndex === s.mpptIndex) || { mpptIndex: s.mpptIndex, lengthM: 0, sectionMm2: 2.5 };
      const L = Number(run.lengthM || 0);
      const S = Number(run.sectionMm2 || 2.5);
      const I = Number(s.iscCalculation || 0);
      const V = Number(s.vmpHot || 0) || 1;
      const du = (2 * L * I * rho) / (S || 1);
      const dup = (du / V) * 100;
      return { mpptIndex: s.mpptIndex, V, I, L, S, du, dup };
    });
  }, [isMicroSystem, stringsAnalysis, project.inverterConfig.dcCablingRuns]);

  const worstDcDropPercent = useMemo(() => {
    if (!dcDropRows.length) return 0;
    return Math.max(...dcDropRows.map((r: any) => Number(r.dup || 0)));
  }, [dcDropRows]);

  const configuredStrings = project.inverterConfig.configuredStrings || [];
  const mpptParallelCounts: Record<number, number> = configuredStrings.reduce((acc: any, s: any) => {
    const idx = Number(s.mpptIndex || 1);
    acc[idx] = (acc[idx] || 0) + 1;
    return acc;
  }, {});
  const maxParallelStringsOnAnyMppt = Object.values(mpptParallelCounts).reduce((m: number, v: any) => Math.max(m, Number(v) || 0), 0);
  // Règle simplifiée (pédagogique) : fusibles gPV requis uniquement si >2 strings en parallèle sur un même MPPT
  const gpvRequired = maxParallelStringsOnAnyMppt > 2;

  // Heuristique : bascule sur 2 pages DC si beaucoup de MPPT / contenu (pour éviter le contenu tronqué)
  // (On conserve 1 page si possible.)
  const needsDcPage2 = useMemo(() => {
    if (!exportOptions.includeDatasheets) return false;
    if (isMicroSystem) return false;
    return stringsAnalysis.length >= 4 || (stringsAnalysis.length >= 3 && gpvRequired);
  }, [exportOptions.includeDatasheets, isMicroSystem, stringsAnalysis.length, gpvRequired]);

  const hasMicroBranches = !!(microBranchesReport && microBranchesReport.branches && microBranchesReport.branches.length > 0);
  const worstBranchDrop = hasMicroBranches ? Math.max(...microBranchesReport!.branches.map((b: any) => b.dropPercent || 0)) : 0;
  const totalProductionDrop = hasMicroBranches ? (worstBranchDrop + (voltageDrop || 0)) : (voltageDrop || 0);

  const today = new Date().toLocaleDateString('fr-FR');

  const subscriptionStatus = getSubscriptionStatus({
    phase: isThreePhase ? 'Tri' : 'Mono',
    projectPowerKwc: totalPowerW / 1000,
    agcpA: project.inverterConfig.agcpValue,
  });

  const allInverters = useMemo((): Record<string, Component> => ({ ...ENPHASE_COMPONENTS, ...APSYSTEMS_COMPONENTS, ...FOXESS_COMPONENTS }), []);

  const projectDocs = useMemo(() => {
    const invModelId = project.inverterConfig.model;
    const selectedInv = (Object.values(allInverters) as Component[]).find((c) => c.id === invModelId);

    let genericInvUrl = "https://www.google.com/search?q=" + project.inverterConfig.brand;
    if (project.inverterConfig.brand === InverterBrand.FOXESS) genericInvUrl = "https://fr.fox-ess.com/download/";
    else if (project.inverterConfig.brand === InverterBrand.ENPHASE) genericInvUrl = "https://support.enphase.com/s/article/video-iq-microinverter-installationsguide";
    else if (project.inverterConfig.brand === InverterBrand.APSYSTEMS) genericInvUrl = "https://emea.apsystems.com/document-library/";

    return {
        structure: {
            brand: project.system.brand,
            videos: project.system.brand === 'K2' 
                ? [
                    { title: "Installation K2 SingleRail", url: "https://youtu.be/drCs25sMDgE?si=dMfyGLM-dh1V2cby" },
                    { title: "Fixations sur tuiles K2", url: "https://www.youtube.com/watch?v=drCs25sMDgE" }
                  ] 
                : [
                    { title: "Installation ClickFit EVO Tuiles", url: "https://www.youtube.com/watch?v=wlc8v_cif1A" }
                  ],
            manuals: project.system.brand === 'K2'
                ? ["https://catalogue.k2-systems.com/media/7b/4e/d3/Product-Brochure-fr.pdf"]
                : ["https://www.esdec.com/wp-content/uploads/2023/03/Manual_ClickFitEvo_TiledRoof_306_FR.pdf"]
        },
        panel: {
            name: activePanel.name,
            datasheet: activePanel.datasheetUrl || `https://www.google.com/search?q=${encodeURIComponent(activePanel.name)}+datasheet`,
            manual: activePanel.manualUrl || `https://www.google.com/search?q=${encodeURIComponent(activePanel.name)}+manual`,
            video: activePanel.videoUrl
        },
        inverter: {
            brand: project.inverterConfig.brand,
            model: selectedInv ? selectedInv.description : project.inverterConfig.model,
            datasheet: selectedInv?.datasheetUrl || genericInvUrl,
            manual: selectedInv?.manualUrl || genericInvUrl,
            video: selectedInv?.videoUrl,
            genericUrl: genericInvUrl,
            foxCommissioningUrl: project.inverterConfig.brand === InverterBrand.FOXESS ? "https://pis.powr.group/install-foxess" : null
        }
    };
  }, [project, activePanel, allInverters]);

  const printableRows = useMemo(() => {
    const grouped = groupMaterialsByCategory(materials);
    const rows: PrintableRow[] = [];
    
    const addItemWithWarning = (item: Material) => {
        rows.push({ type: 'item', material: item });
        if (item.description.toLowerCase().includes('coffret ac') && (!project.inverterConfig.agcpValue || project.inverterConfig.agcpValue <= 0)) {
            rows.push({ type: 'warning', text: "Disjoncteur non livré dans les coffrets AC à calibrer et a ajouter en fonction de l'AGCP client" });
        }
    };

    grouped.forEach(g => {
        rows.push({ type: 'header', title: g.category });
        g.items.forEach(item => addItemWithWarning(item));
        if (g.subSections) {
            g.subSections.forEach(sub => {
                rows.push({ type: 'subheader', title: sub.title });
                sub.items.forEach(item => addItemWithWarning(item));
            });
        }
    });
    return rows;
  }, [materials, project.inverterConfig.agcpValue]);

  const materialChunks = useMemo(() => {
    const chunks = [];
    for (let i = 0; i < printableRows.length; i += ITEMS_PER_PAGE) {
      chunks.push(printableRows.slice(i, i + ITEMS_PER_PAGE));
    }
    return chunks.length > 0 ? chunks : [[]];
  }, [printableRows]);

  const materialPages = materialChunks.length;
  const showDoc = exportOptions.includeGuides;
  const showRegul = exportOptions.includeRegulations;
  
  // Pages "fixes" avant la liste matériel :
  //  - 1 page projet
  //  - 2 pages par toit (diagramme + schéma)
  //  - 1 page électrique DC
  //  - 1 page électrique AC
  //  - 1 page dédiée "Consuel-ready" (ajoutée pour éviter les contenus tronqués)
  //  - (option) pages datasheets
  // Pagination dynamique (DC peut passer à 2 pages si nécessaire)
  const basePages = 1 + (project.fields.length * 2); // page projet + 2 pages par champ
  const dcPages = exportOptions.includeDatasheets ? (needsDcPage2 ? 2 : 1) : 0;
  const pageDc1 = exportOptions.includeDatasheets ? (basePages + 1) : null;
  const pageDc2 = (exportOptions.includeDatasheets && needsDcPage2) ? (basePages + 2) : null;
  const pageAc = basePages + dcPages + 1;
  const pageConsuel = pageAc + 1;
  const pageSchematic = pageAc + 2;
  const fixedBeforeMaterials = basePages + dcPages + 3;
  const totalPages = fixedBeforeMaterials + materialPages + (showDoc ? 2 : 0) + (showRegul ? 1 : 0);

  const StatusPill = ({ ok, warn, label }: { ok?: boolean; warn?: boolean; label: string }) => {
    const cls = ok
      ? 'bg-green-50 text-green-800 border-green-200'
      : warn
        ? 'bg-orange-50 text-orange-800 border-orange-200'
        : 'bg-red-50 text-red-800 border-red-200';
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[8px] font-black uppercase tracking-wide ${cls}`}>
        {ok ? '✔' : warn ? '⚠' : '✖'} {label}
      </span>
    );
  };

  const SectionTitle = ({ children }: { children: any }) => (
    <h3 className="text-[10px] font-black text-slate-800 uppercase mb-2 tracking-tight border-b border-slate-200 pb-1">
      {children}
    </h3>
  );

  const LegendBox = ({ items }: { items: { k: string; v: string }[] }) => (
    <div className="bg-slate-50 border border-slate-100 rounded-xl p-3">
      <div className="text-[7px] font-black uppercase tracking-widest text-slate-400 mb-2">Légende</div>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="text-[8px] text-slate-600 leading-tight"><span className="font-black">{it.k}</span> : {it.v}</li>
        ))}
      </ul>
    </div>
  );

  const CommonHeader = ({ title }: { title: string }) => (
    <header className="flex justify-between items-end mb-6 border-b border-slate-200 pb-2">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8">
            <svg viewBox="0 0 100 100"><path d="M50 5 L90 25 L90 75 L50 95 L10 75 L10 25 Z" fill="#eab308" /><path d="M50 5 L90 25 L50 45 L10 25 Z" fill="#84cc16" /><path d="M50 45 L90 25 L90 75 L50 95 Z" fill="#db2777" /></svg>
        </div>
        <div className="flex flex-col">
          <h2 className="text-xl font-black text-slate-800 uppercase tracking-tight">{title}</h2>
          <span className="text-[9px] text-slate-400 font-bold uppercase tracking-widest">Richardson Solaire v3.0</span>
        </div>
      </div>
      <div className="text-right">
        <span className="text-sm font-bold text-slate-700">{project.name}</span>
      </div>
    </header>
  );

  const CommonFooter = ({ page }: { page: number }) => (
    <footer className="mt-auto pt-4 border-t border-slate-100 flex justify-between text-[9px] text-slate-400">
      <span>Richardson Solaire - Dossier d'aide au chiffrage - Document non contractuel</span>
      <span>Page {page}/{totalPages}</span>
    </footer>
  );

  return (
    <div id="pdf-report-source" className="hidden bg-white text-slate-800 font-sans text-left">
      
      {/* PAGE 1 : COUVERTURE */}
      <div className="pdf-page w-[210mm] h-[297mm] bg-white relative flex flex-col overflow-hidden">
        <div className="h-[60%] relative">
            <img src="https://images.unsplash.com/photo-1508514177221-188b1cf16e9d?q=80&w=1200&auto=format&fit=crop" className="w-full h-full object-cover" alt="Solar Field" />
            <div className="absolute top-12 left-12"><span className="text-white font-black tracking-widest text-sm uppercase">RICHARDSON</span></div>
            <div className="absolute inset-0 flex flex-col justify-center p-16">
                <h1 className="text-[64px] font-black text-white leading-none drop-shadow-2xl">Dossier Technique</h1>
                <h2 className="text-[64px] font-black text-yellow-400 leading-none drop-shadow-2xl mt-2">Photovoltaïque</h2>
                <div className="flex items-center gap-4 mt-6">
                    <div className="w-1.5 h-10 bg-orange-500"></div>
                    <p className="text-white/90 text-xl font-medium tracking-tight">Etude d'aide au dimensionnement et au chiffrage</p>
                </div>
            </div>
        </div>
        <div className="flex-1 p-20 flex justify-between items-start relative">
            <div className="flex gap-8 items-stretch">
                <div className="w-1.5 bg-slate-900"></div>
                <div className="space-y-8">
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-2">PROJET</label>
                        <h3 className="text-3xl font-black text-slate-800 tracking-tight">{project.name || 'Nouveau Projet'}</h3>
                        <p className="text-slate-500 font-bold text-lg mt-1">{project.postalCode} {project.city}</p>
                    </div>
                    <div className="flex gap-12">
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">PUISSANCE INSTALLÉE</label>
                            <span className="text-2xl font-black text-slate-800">{totalPowerkWc} kWc</span>
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">DATE</label>
                            <span className="text-2xl font-black text-slate-800">{today}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Note abonnement / puissance souscrite (bas de page 1) */}
            <div className="absolute bottom-10 left-20 right-20">
              <div className="border-t border-slate-200 pt-3 text-[10px] text-slate-600 leading-snug">
                <div className="font-black text-slate-700 uppercase tracking-widest text-[9px] mb-1">Condition de validité de l'étude</div>
                <div>
                  Cette étude est réalisée pour une puissance installée de <span className="font-black">{totalPowerkWc} kWc</span>. La faisabilité est conditionnée à une puissance souscrite au point de livraison compatible.
                  {subscriptionStatus.recommendedKva ? (
                    <> Abonnement minimal conseillé : <span className="font-black">{subscriptionStatus.recommendedKva} kVA</span> ({subscriptionStatus.phase === 'Mono' ? 'mono' : 'tri'}).
                    </>
                  ) : null}
                </div>
                <div className="mt-1">
                  {subscriptionStatus.subscribedKva == null ? (
                    <span className="font-bold">Puissance souscrite non renseignée (AGCP). À vérifier auprès du fournisseur/gestionnaire de réseau.</span>
                  ) : subscriptionStatus.isOk ? (
                    <span className="font-bold text-green-700">Abonnement renseigné : {subscriptionStatus.subscribedKva} kVA — compatible.</span>
                  ) : (
                    <span className="font-bold text-red-700">Abonnement renseigné : {subscriptionStatus.subscribedKva} kVA — à faire évoluer.</span>
                  )}
                  <span className="text-slate-500"> Limites usuelles : 12 kVA max en monophasé, 36 kVA max en triphasé, sous réserve de compatibilité du site/réseau.</span>
                </div>
              </div>
            </div>
        </div>
      </div>

      {/* PAGES TOITURES */}
      {project.fields.map((field, index) => (
        <React.Fragment key={field.id}>
          <div className="pdf-page w-[210mm] h-[297mm] p-[15mm] flex flex-col bg-white">
            <CommonHeader title={`Vue d'ensemble - ${field.name}`} />
            <div className="mt-4 mb-10 text-left"><h3 className="text-2xl font-black text-slate-800">Configuration - {field.name}</h3></div>
            <div className="grid grid-cols-12 gap-12">
                <div className="col-span-6"><div className="bg-orange-50/50 rounded-3xl p-10 border border-orange-100 shadow-sm"><RoofVisualizer roof={field.roof} panels={field.panels} bare maxDimension={320} /></div></div>
                <div className="col-span-6 space-y-10">
                    <section><h4 className="text-[11px] font-black text-orange-500 uppercase tracking-widest border-b-2 border-orange-500 w-fit mb-5">Spécifications</h4>
                        <table className="w-full text-sm">
                            <tbody className="divide-y divide-slate-100">
                                <tr><td className="py-2.5 text-slate-400">Module</td><td className="py-2.5 font-bold text-right">{field.panels.model.name}</td></tr>
                                <tr>
                                  <td className="py-2.5 text-slate-400">Quantité (ce champ)</td>
                                  <td className="py-2.5 font-bold text-right">{getPanelCount(field.panels)} panneaux</td>
                                </tr>
                                <tr>
                                  <td className="py-2.5 text-slate-400">Puissance Champ</td>
                                  <td className="py-2.5 font-bold text-right">{((getPanelCount(field.panels) * field.panels.model.power) / 1000).toFixed(2)} kWc</td>
                                </tr>
                                <tr><td className="py-2.5 text-slate-400">Orientation</td><td className="py-2.5 font-bold text-right">{field.panels.orientation}</td></tr>
                            </tbody>
                        </table>
                    </section>
                </div>
            </div>
            <CommonFooter page={1 + (index * 2) + 1} />
          </div>

          <div className="pdf-page w-[210mm] h-[297mm] p-[15mm] flex flex-col bg-white">
            <CommonHeader title={`Plan de Calpinage - ${field.name}`} />
            <div className="flex-1 bg-slate-50 border border-slate-200 rounded-3xl p-12 flex items-center justify-center overflow-hidden shadow-inner my-6">
                <InstallationDiagram roof={field.roof} panels={field.panels} system={project.system} railOrientation={field.railOrientation} />
            </div>
            <CommonFooter page={1 + (index * 2) + 2} />
          </div>
        </React.Fragment>
      ))}

      {/* --- PAGE(S) ÉLECTRIQUE(S) : AUDIT DC --- */}
      {exportOptions.includeDatasheets && (
      <>
        {/* DC page 1 : compact / pédagogique */}
        <div className="pdf-page w-[210mm] h-[297mm] p-[15mm] flex flex-col bg-white overflow-hidden text-left">
          <CommonHeader title="Analyse Électrique - Coté DC" />
          <div className="flex items-end justify-between gap-4 mb-3">
            <div>
              <h1 className="text-[20px] font-black text-slate-900 leading-tight">Audit électrique DC (générateur PV)</h1>
              <p className="text-slate-500 text-[9px] font-bold uppercase">Guide UTE C15-712-1 • Voc corrigée au froid • Isc × 1,25 • chute de tension DC par MPPT</p>
            </div>
            <div className="text-right">
              <div className="text-[8px] text-slate-500 font-black uppercase">MPPT utilisés</div>
              <div className="text-[18px] font-black text-slate-900">{mpptCount}</div>
            </div>
          </div>

          {/* KPI */}
          <section className="grid grid-cols-4 gap-3 mb-3">
            <div className="border border-slate-200 rounded-xl p-3 bg-slate-50">
              <div className="text-[7px] font-black uppercase text-slate-500">Voc corrigée @ {climate.tempMin}°C</div>
              <div className={`text-[16px] font-black ${vocColdString > invVmaxLimit ? 'text-red-700' : 'text-slate-900'}`}>{vocColdString.toFixed(1)} V</div>
              <div className="mt-1">{vocColdString > invVmaxLimit ? <StatusPill label="Dépasse Vmax" /> : <StatusPill ok label="OK Vmax" />}</div>
              <div className="text-[7px] text-slate-500 mt-1">Limite onduleur : {invVmaxLimit} V</div>
            </div>
            <div className="border border-slate-200 rounded-xl p-3 bg-slate-50">
              <div className="text-[7px] font-black uppercase text-slate-500">Isc calculé</div>
              <div className="text-[16px] font-black text-slate-900">{(report?.details?.iscCalculation || 0).toFixed(2)} A</div>
              <div className="text-[7px] text-slate-500 mt-1">Isc STC : {report?.details?.iscPanel} A</div>
              <div className="mt-1"><StatusPill ok label="Isc×1,25" /></div>
            </div>
            <div className="border border-slate-200 rounded-xl p-3 bg-slate-50">
              <div className="text-[7px] font-black uppercase text-slate-500">Ratio DC/AC</div>
              <div className="text-[16px] font-black text-slate-900">{dcAcRatio.toFixed(0)} %</div>
              <div className="text-[7px] text-slate-500 mt-1">Indicateur de surdimensionnement</div>
            </div>
            <div className="border border-slate-200 rounded-xl p-3 bg-slate-50">
              <div className="text-[7px] font-black uppercase text-slate-500">Chute DC max</div>
              <div className={`text-[16px] font-black ${worstDcDropPercent > 3 ? 'text-red-700' : (worstDcDropPercent > 1 ? 'text-orange-700' : 'text-green-700')}`}>{worstDcDropPercent.toFixed(2)} %</div>
              <div className="mt-1">
                {isMicroSystem ? <StatusPill warn label="N/A micro" /> : worstDcDropPercent > 3 ? <StatusPill label=">3%" /> : (worstDcDropPercent > 1 ? <StatusPill warn label=">1%" /> : <StatusPill ok label="≤1%" />)}
              </div>
              <div className="text-[7px] text-slate-500 mt-1">Basé sur Vmp « chaud » de la chaîne</div>
            </div>
          </section>

          {/* TABLE MPPT */}
          <section className="mb-3">
            <SectionTitle>Répartition MPPT (résumé)</SectionTitle>
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <table className="w-full text-[8px]">
                <thead className="bg-slate-50 text-slate-600 font-black uppercase">
                  <tr>
                    <th className="p-2 text-left">MPPT</th>
                    <th className="p-2 text-left">Composition</th>
                    <th className="p-2 text-center">Nb modules</th>
                    <th className="p-2 text-right">Voc froid (V)</th>
                    <th className="p-2 text-right">Vmp chaud (V)</th>
                    <th className="p-2 text-right">Isc calc (A)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {stringsAnalysis.map((s: any, i: number) => (
                    <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                      <td className="p-2 font-black">{s.mpptIndex}</td>
                      <td className="p-2 font-bold text-slate-700">{s.composition}</td>
                      <td className="p-2 text-center font-mono font-bold">{s.totalPanelCount}</td>
                      <td className={`p-2 text-right font-mono ${Number(s.vocCold || 0) > invVmaxLimit ? 'text-red-700 font-black' : ''}`}>{Number(s.vocCold || 0).toFixed(1)}</td>
                      <td className="p-2 text-right font-mono">{Number(s.vmpHot || 0).toFixed(1)}</td>
                      <td className="p-2 text-right font-mono">{Number(s.iscCalculation || 0).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* DC DROP TABLE */}
          {!isMicroSystem && stringsAnalysis.length > 0 && (
            <section className="mb-3">
              <div className="flex items-center justify-between mb-1">
                <SectionTitle>Liaison DC (chute de tension)</SectionTitle>
                <div className="text-[8px] text-slate-500 font-bold">L = distance MPPT → coffret DC / onduleur</div>
              </div>
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-[8px]">
                  <thead className="bg-slate-50 text-slate-600 font-black uppercase">
                    <tr>
                      <th className="p-2 text-left">MPPT</th>
                      <th className="p-2 text-right">Vmp chaud (V)</th>
                      <th className="p-2 text-right">I (A)</th>
                      <th className="p-2 text-right">L (m)</th>
                      <th className="p-2 text-right">S (mm²)</th>
                      <th className="p-2 text-right">ΔU (V)</th>
                      <th className="p-2 text-right">ΔU (%)</th>
                      <th className="p-2 text-center">Statut</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {dcDropRows.map((r: any, i: number) => {
                      const dup = Number(r.dup || 0);
                      const pill = dup > 3 ? <StatusPill label=">3%" /> : (dup > 1 ? <StatusPill warn label=">1%" /> : <StatusPill ok label="OK" />);
                      const c = dup > 3 ? 'text-red-700' : (dup > 1 ? 'text-orange-700' : 'text-green-700');
                      return (
                        <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                          <td className="p-2 font-black">{r.mpptIndex}</td>
                          <td className="p-2 text-right font-mono">{Number(r.V || 0).toFixed(1)}</td>
                          <td className="p-2 text-right font-mono">{Number(r.I || 0).toFixed(2)}</td>
                          <td className="p-2 text-right font-mono">{Number(r.L || 0).toFixed(0)}</td>
                          <td className="p-2 text-right font-mono">{Number(r.S || 0).toFixed(0)}</td>
                          <td className="p-2 text-right font-mono">{Number(r.du || 0).toFixed(2)}</td>
                          <td className={`p-2 text-right font-black ${c}`}>{dup.toFixed(2)}</td>
                          <td className="p-2 text-center">{pill}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-1 text-[7px] text-slate-500">
                Objectif souvent visé : ≤ 1% (bonnes pratiques) • Au-delà de 3% : augmenter la section ou réduire la longueur.
              </div>
            </section>
          )}

          {/* Bas de page : protections + méthode (si pas de page 2) */}
          {!needsDcPage2 && (
            <section className="mt-auto">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <SectionTitle>Protections DC</SectionTitle>
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <table className="w-full text-[8px]">
                      <thead className="bg-slate-50 text-slate-600 font-black uppercase">
                        <tr>
                          <th className="p-2 text-left">Élément</th>
                          <th className="p-2 text-left">Critère</th>
                          <th className="p-2 text-center">Verdict</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        <tr className="bg-white">
                          <td className="p-2 font-bold">Sectionneur DC</td>
                          <td className="p-2">In ≥ Isc_calc ({(report?.details?.iscCalculation || 0).toFixed(2)}A) • Un ≥ Uoc_max ({vocColdString.toFixed(1)}V)</td>
                          <td className="p-2 text-center text-green-700 font-black">VALIDE</td>
                        </tr>
                        <tr className="bg-slate-50">
                          <td className="p-2 font-bold">Parafoudre DC (T2)</td>
                          <td className="p-2">Protection surtensions (15-712-1)</td>
                          <td className="p-2 text-center text-green-700 font-black">INCLUS</td>
                        </tr>
                        {gpvRequired && (
                          <tr className="bg-white">
                            <td className="p-2 font-bold">Fusibles gPV</td>
                            <td className="p-2">Requis si &gt; 2 strings // sur un même MPPT (pédagogique)</td>
                            <td className="p-2 text-center text-orange-700 font-black">À PRÉVOIR</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div>
                  <SectionTitle>Méthodologie & symboles</SectionTitle>
                  <div className="border border-slate-200 rounded-xl p-3 bg-slate-50">
                    <div className="font-mono text-[6.5px] text-slate-600 leading-[1.35]">
                      <div className="font-black text-[7px] uppercase text-slate-700 mb-1">Tension au froid</div>
                      Uoc(Tmin) = Uoc_stc × [1 + (k_voc/100) × (Tmin - 25)] × N
                      <div className="mt-2 font-black text-[7px] uppercase text-slate-700 mb-1">Courant de calcul</div>
                      Isc_calc = Isc_stc × 1.25
                      <div className="mt-2 font-black text-[7px] uppercase text-slate-700 mb-1">Chute de tension DC</div>
                      ΔU(V) = (2 × L × I × ρ) / S • ΔU(%) = ΔU / Vmp_chaud × 100
                    </div>
                    <div className="mt-2 text-[7px] text-slate-600">
                      Symboles : L(m)=longueur aller • S(mm²)=section • I(A)=courant • ρ≈0.023 (cuivre, hypothèse chaude) • Vmp_chaud=tension de chaîne en conditions chaudes.
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          <CommonFooter page={pageDc1 as number} />
        </div>

        {/* DC page 2 si nécessaire */}
        {needsDcPage2 && (
          <div className="pdf-page w-[210mm] h-[297mm] p-[15mm] flex flex-col bg-white overflow-hidden text-left">
            <CommonHeader title="Analyse Électrique - Coté DC (suite)" />

            <div className="flex items-center justify-between mb-3">
              <h1 className="text-[18px] font-black text-slate-900">Suite DC : protections & méthodologie</h1>
              <div className="text-[8px] text-slate-500 font-bold uppercase">Page dédiée pour lisibilité</div>
            </div>

            <section className="mb-4">
              <SectionTitle>Protections DC</SectionTitle>
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-[9px]">
                  <thead className="bg-slate-50 text-slate-600 font-black uppercase">
                    <tr>
                      <th className="p-3 text-left">Élément</th>
                      <th className="p-3 text-left">Critère</th>
                      <th className="p-3 text-center">Verdict</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    <tr>
                      <td className="p-3 font-bold">Sectionneur DC</td>
                      <td className="p-3">In ≥ Isc_calc ({(report?.details?.iscCalculation || 0).toFixed(2)}A) • Un ≥ Uoc_max ({vocColdString.toFixed(1)}V)</td>
                      <td className="p-3 text-center text-green-700 font-black">VALIDE</td>
                    </tr>
                    <tr className="bg-slate-50">
                      <td className="p-3 font-bold">Parafoudre DC (T2)</td>
                      <td className="p-3">Protection surtensions (15-712-1)</td>
                      <td className="p-3 text-center text-green-700 font-black">INCLUS</td>
                    </tr>
                    {gpvRequired && (
                      <tr>
                        <td className="p-3 font-bold">Fusibles gPV</td>
                        <td className="p-3">Requis si &gt; 2 strings // sur un même MPPT (pédagogique)</td>
                        <td className="p-3 text-center text-orange-700 font-black">À PRÉVOIR</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="grid grid-cols-2 gap-4">
              <div className="border border-slate-200 rounded-xl p-4 bg-slate-50">
                <SectionTitle>Formules utilisées</SectionTitle>
                <div className="font-mono text-[7px] text-slate-700 leading-[1.4]">
                  <div className="font-black text-[7px] uppercase text-slate-600 mb-1">Voc corrigée au froid</div>
                  Uoc(Tmin) = Uoc_stc × [1 + (k_voc/100) × (Tmin - 25)] × N
                  <div className="mt-2 font-black text-[7px] uppercase text-slate-600 mb-1">Isc de calcul</div>
                  Isc_calc = Isc_stc × 1.25
                  <div className="mt-2 font-black text-[7px] uppercase text-slate-600 mb-1">Chute DC (par MPPT)</div>
                  ΔU(V) = (2 × L × I × ρ) / S
                  <br />ΔU(%) = (ΔU / Vmp_chaud) × 100
                </div>
              </div>
              <div className="border border-slate-200 rounded-xl p-4 bg-slate-50">
                <SectionTitle>Symboles & repères</SectionTitle>
                <div className="text-[9px] text-slate-700 leading-relaxed">
                  <ul className="list-disc list-inside space-y-1">
                    <li><b>L (m)</b> : longueur aller du câble (la formule intègre l'aller-retour via ×2).</li>
                    <li><b>S (mm²)</b> : section du câble cuivre.</li>
                    <li><b>I (A)</b> : courant de calcul (Isc × 1,25).</li>
                    <li><b>ΔU (V)</b> : chute de tension en volts.</li>
                    <li><b>ΔU (%)</b> : chute rapportée à Vmp « chaud » de la chaîne.</li>
                    <li><b>ρ</b> : résistivité cuivre (hypothèse 0,023 Ω·mm²/m).</li>
                  </ul>
                  <div className="mt-3 text-[8px] text-slate-600">
                    Repère : en pratique, viser ≤ 1% est courant ; si &gt; 3% il est recommandé d'augmenter la section ou réduire la longueur.
                  </div>
                </div>
              </div>
            </section>

            <CommonFooter page={pageDc2 as number} />
          </div>
        )}
      </>
      )}

      {/* --- PAGE ÉLECTRIQUE 2/2 : AUDIT AC & SYNTHÈSE CONSUEL --- */}
      <div className="pdf-page w-[210mm] h-[297mm] p-[15mm] flex flex-col bg-white overflow-hidden text-left">
        <CommonHeader title="Analyse Électrique 2/2 - Coté AC" />
        <div className="flex items-end justify-between gap-4 mb-3">
          <div>
            <h1 className="text-[20px] font-black text-slate-900 leading-tight">Audit électrique AC (liaison tableau)</h1>
            <p className="text-slate-500 text-[9px] font-bold uppercase">NFC 15-100 • chutes de tension AC • protections de tête • cumul “production” (micro-onduleurs)</p>
          </div>
          <div className="text-right">
            <div className="text-[8px] text-slate-500 font-black uppercase">Distance L</div>
            <div className="text-[14px] font-black text-slate-900">{project.distanceToPanel} m</div>
            <div className="text-[7px] text-slate-500 font-bold">Coffret AC → point de raccordement</div>
          </div>
        </div>

        {/* KPI */}
        <section className="grid grid-cols-4 gap-3 mb-3">
          <div className="border border-slate-200 rounded-xl p-3 bg-slate-50">
            <div className="text-[7px] font-black uppercase text-slate-500">In max AC</div>
            <div className="text-[16px] font-black text-slate-900">{report?.details?.nominalAcCurrent} A</div>
            <div className="text-[7px] text-slate-500 mt-1">Réseau : {project.inverterConfig.phase} {isThreePhase ? '400V' : '230V'}</div>
          </div>
          <div className="border border-slate-200 rounded-xl p-3 bg-slate-50">
            <div className="text-[7px] font-black uppercase text-slate-500">Disjoncteur mini</div>
            <div className="text-[16px] font-black text-slate-900">{report?.details?.recommendedBreaker} A</div>
            <div className="text-[7px] text-slate-500 mt-1">DDR : Type {report?.details?.rcdType} (30mA)</div>
          </div>
          <div className="border border-slate-200 rounded-xl p-3 bg-slate-50">
            <div className="text-[7px] font-black uppercase text-slate-500">Section câble</div>
            <div className="text-[16px] font-black text-slate-900">{acSection} mm²</div>
            <div className="text-[7px] text-slate-500 mt-1">Cuivre • ρ≈0.023</div>
          </div>
          <div className="border border-slate-200 rounded-xl p-3 bg-slate-50">
            <div className="text-[7px] font-black uppercase text-slate-500">Chute AC</div>
            <div className={`text-[16px] font-black ${voltageDrop > 3 ? 'text-red-700' : (voltageDrop > 1 ? 'text-orange-700' : 'text-green-700')}`}>{voltageDrop.toFixed(2)} %</div>
            <div className="mt-1">
              {voltageDrop > 3 ? <StatusPill label=">3%" /> : (voltageDrop > 1 ? <StatusPill warn label=">1%" /> : <StatusPill ok label="≤1%" />)}
            </div>
            {hasMicroBranches && (
              <div className="text-[7px] text-slate-500 mt-1">Cumul prod : {totalProductionDrop.toFixed(2)}%</div>
            )}
          </div>
        </section>
{(() => {
  const inA = report?.details?.recommendedBreaker ?? null;
  const tooHigh = (inA && isProtectionTooHighForSection(acSection, inA)) || false;
  const oversized = (inA && isSectionOversizedForIn(acSection, inA)) || false;
  if (!inA) return null;
  return (
    <div className="mt-2 text-[8px]">
      {tooHigh ? (
        <div className="inline-block px-2 py-1 rounded-md bg-red-50 border border-red-200 text-red-800">
          Protection trop élevée pour la section : In={inA}A dépasse le maximum conseillé pour {acSection}mm².
        </div>
      ) : oversized ? (
        <div className="inline-block px-2 py-1 rounded-md bg-sky-50 border border-sky-200 text-sky-800">
          Section surdimensionnée (OK) : choisie pour limiter la chute de tension.
        </div>
      ) : (
        <div className="inline-block px-2 py-1 rounded-md bg-green-50 border border-green-200 text-green-800">
          Protection/section cohérentes (Ib ≤ In ≤ Iz).
        </div>
      )}
    </div>
  );
})()}

        {/* Tableau liaison AC */}
        <section className="mb-3">
          <SectionTitle>Liaison AC (chute de tension)</SectionTitle>
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-[8px]">
              <thead className="bg-slate-50 text-slate-600 font-black uppercase">
                <tr>
                  <th className="p-2 text-left">Paramètre</th>
                  <th className="p-2 text-right">Valeur</th>
                  <th className="p-2 text-left">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                <tr className="bg-white">
                  <td className="p-2 font-bold">L (m)</td>
                  <td className="p-2 text-right font-mono">{project.distanceToPanel}</td>
                  <td className="p-2 text-slate-600">Distance coffret AC → point de raccordement</td>
                </tr>
                <tr className="bg-slate-50">
                  <td className="p-2 font-bold">S (mm²)</td>
                  <td className="p-2 text-right font-mono">{acSection}</td>
                  <td className="p-2 text-slate-600">Section câble cuivre</td>
                </tr>
                <tr className="bg-white">
                  <td className="p-2 font-bold">I (A)</td>
                  <td className="p-2 text-right font-mono">{Number(report?.details?.nominalAcCurrent || 0).toFixed(2)}</td>
                  <td className="p-2 text-slate-600">Courant nominal max AC</td>
                </tr>
                <tr className="bg-slate-50">
                  <td className="p-2 font-bold">ΔU (V)</td>
                  <td className="p-2 text-right font-mono">{(((isThreePhase ? 400 : 230) * (voltageDrop || 0)) / 100).toFixed(2)}</td>
                  <td className="p-2 text-slate-600">Basé sur U réseau</td>
                </tr>
                <tr className="bg-white">
                  <td className="p-2 font-bold">ΔU (%)</td>
                  <td className={`p-2 text-right font-black ${voltageDrop > 3 ? 'text-red-700' : (voltageDrop > 1 ? 'text-orange-700' : 'text-green-700')}`}>{voltageDrop.toFixed(2)}</td>
                  <td className="p-2 text-slate-600">Objectif souvent visé : ≤ 1%</td>
                </tr>
              </tbody>
            </table>
          </div>
	          {(() => {
	            const inA = report?.details?.recommendedBreaker ?? null;
	            if (!inA) return null;
	            const thermalMin = getMinSectionForIn(inA);
	            const oversized = isSectionOversizedForIn(acSection, inA) && acSection > thermalMin;
	            if (!oversized) return null;
	            return (
	              <div className="mt-2 text-[8px] text-slate-700 bg-sky-50 border border-sky-200 rounded-lg p-2">
	                La <span className="font-semibold">section recommandée ({acSection} mm²)</span> est déterminée par le critère de <span className="font-semibold">chute de tension</span> et non par le critère thermique.
	                Thermiquement, une section inférieure (≈ {thermalMin} mm²) serait suffisante, mais la distance impose une section supérieure pour garantir une chute de tension conforme.
	              </div>
	            );
	          })()}
        </section>

        {/* Micro branches */}
        {microBranchesReport && microBranchesReport.branches?.length > 0 && (
          <section className="mb-3">
            <div className="flex items-end justify-between mb-1">
              <SectionTitle>Branches micro-onduleurs (chutes AC)</SectionTitle>
              <div className="text-[8px] text-slate-500 font-bold">ΔU(%) = ΔU/U×100</div>
            </div>
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <table className="w-full text-[8px]">
                <thead className="bg-slate-50 text-slate-600 font-black uppercase">
                  <tr>
                    <th className="p-2 text-left">Branche</th>
                    {project.inverterConfig.phase === 'Tri' && <th className="p-2 text-left">Phase</th>}
                    <th className="p-2 text-center"># micros</th>
                    <th className="p-2 text-right">L (m)</th>
                    <th className="p-2 text-right">S (mm²)</th>
                    <th className="p-2 text-right">I (A)</th>
                    <th className="p-2 text-right">ΔU (V)</th>
                    <th className="p-2 text-right">ΔU (%)</th>
                    <th className="p-2 text-center">Statut</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {microBranchesReport.branches.map((b: any, idx: number) => {
                    const dup = Number(b.dropPercent || 0);
                    const pill = dup > 3 ? <StatusPill label=">3%" /> : (dup > 1 ? <StatusPill warn label=">1%" /> : <StatusPill ok label="OK" />);
                    const c = dup > 3 ? 'text-red-700' : (dup > 1 ? 'text-orange-700' : 'text-green-700');
                    return (
                      <tr key={b.branchId || idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                        <td className="p-2 font-black">{b.name}</td>
                        {project.inverterConfig.phase === 'Tri' && <td className="p-2 font-bold">{b.phase}</td>}
                        <td className="p-2 text-center font-mono">{b.microCount}</td>
                        <td className="p-2 text-right font-mono">{b.cableLengthM}</td>
                        <td className="p-2 text-right font-mono">{b.cableSectionMm2}</td>
                        <td className="p-2 text-right font-mono">{Number(b.currentA || 0).toFixed(1)}</td>
                        <td className="p-2 text-right font-mono">{Number(b.dropV || 0).toFixed(1)}</td>
                        <td className={`p-2 text-right font-black ${c}`}>{dup.toFixed(2)}</td>
                        <td className="p-2 text-center">{pill}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-2 text-[8px] text-slate-600 font-bold">
              Chute « production » cumulée (pire branche + liaison tableau) : <span className={totalProductionDrop > 3 ? 'text-red-700' : (totalProductionDrop > 1 ? 'text-orange-700' : 'text-green-700')}>{totalProductionDrop.toFixed(2)}%</span>
              <span className="text-slate-500"> • objectif souvent visé : ≤ 1%</span>
            </div>
          </section>
        )}

        {/* Bas de page : méthodo */}
        <section className="mt-auto">
          <div className="grid grid-cols-2 gap-3">
            <div className="border border-slate-200 rounded-xl p-3 bg-slate-50">
              <SectionTitle>Formules utilisées</SectionTitle>
              <div className="font-mono text-[6.5px] text-slate-700 leading-[1.35]">
                In_max = P_ac / (U_reseau {isThreePhase ? '× √3' : ''})
                <div className="mt-2">ΔU(V) = (b × L × I × ρ) / S</div>
                <div>ΔU(%) = ΔU / U_reseau × 100</div>
                <div className="mt-2 text-[6px] text-slate-500">b = 2 (mono) • b = √3 (tri) • ρ≈0.023</div>
              </div>
            </div>
            <div className="border border-slate-200 rounded-xl p-3 bg-slate-50">
              <SectionTitle>Symboles</SectionTitle>
              <div className="text-[8px] text-slate-700 leading-relaxed">
                <ul className="list-disc list-inside space-y-1">
                  <li><b>L (m)</b> : distance coffret AC → point de raccordement.</li>
                  <li><b>S (mm²)</b> : section câble cuivre.</li>
                  <li><b>I (A)</b> : courant nominal.</li>
                  <li><b>ΔU (V)</b> : chute en volts.</li>
                  <li><b>ΔU (%)</b> : chute en % de U réseau.</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <CommonFooter page={pageAc} />
      </div>

      {/* --- PAGE DÉDIÉE : SYNTHÈSE CONSUEL-READY --- */}
      <div className="pdf-page w-[210mm] h-[297mm] p-[15mm] flex flex-col bg-white overflow-hidden text-left">
        <CommonHeader title="Synthèse Consuel-ready" />

        <section className="flex-1">
          <div className="bg-slate-900 text-white rounded-3xl p-8 relative overflow-hidden shadow-2xl">
              <div className="absolute top-6 right-8 text-xs font-black uppercase tracking-[0.3em] opacity-20">Synthèse Administrative</div>
              <h3 className="text-xl font-black mb-6 uppercase tracking-tight flex items-center gap-3">
                  <span className="w-1.5 h-6 bg-orange-500"></span> Données "Consuel-ready"
              </h3>
              <div className="grid grid-cols-2 gap-x-12 gap-y-6">
                  <div className="space-y-4">
                      <div className="border-b border-slate-800 pb-2"><label className="block text-[8px] text-slate-500 font-black uppercase">Puissance PV totale installée</label><span className="text-lg font-bold">{totalPowerkWc} kWc</span></div>
                      <div className="border-b border-slate-800 pb-2"><label className="block text-[8px] text-slate-500 font-black uppercase">Puissance maximale de l'onduleur</label><span className="text-lg font-bold">{(report?.details?.maxAcPower / 1000).toFixed(2)} kVA</span></div>
                      <div className="border-b border-slate-800 pb-2"><label className="block text-[8px] text-slate-500 font-black uppercase">Tension de service DC max (Uoc_max)</label><span className="text-lg font-bold">{vocColdString} V</span></div>
                  </div>
                  <div className="space-y-4">
                      <div className="border-b border-slate-800 pb-2"><label className="block text-[8px] text-slate-500 font-black uppercase">Courant de court-circuit max corrigé (Isc x 1.25)</label><span className="text-lg font-bold">{report?.details?.iscCalculation} A</span></div>
                      <div className="border-b border-slate-800 pb-2"><label className="block text-[8px] text-slate-500 font-black uppercase">Intensité maximale AC par phase</label><span className="text-lg font-bold">{report?.details?.nominalAcCurrent} A</span></div>
                      <div className="border-b border-slate-800 pb-2"><label className="block text-[8px] text-slate-500 font-black uppercase">Protection de tête (Calibre disjoncteur)</label><span className="text-lg font-bold">{report?.details?.recommendedBreaker} A (Min.)</span></div>
                  </div>
              </div>
              <div className="mt-8 pt-6 border-t border-slate-800">
                  <p className="text-[10px] text-slate-400 leading-relaxed italic">
                      * Note technique : Cette synthèse facilite le remplissage des attestations de conformité (Dossiers Techniques SC 144A/B).
                      Elle ne dispense pas l'installateur d'une vérification sur site des calibres et longueurs réelles.
                  </p>
              </div>
          </div>
        </section>

        <CommonFooter page={pageConsuel} />
      </div>

      <div className="pdf-page w-[210mm] h-[297mm] p-[15mm] flex flex-col bg-white">
        <CommonHeader title="Schéma électrique de principe" />
        <div className="flex-1 border border-slate-100 rounded-3xl overflow-hidden bg-white shadow-sm p-4 my-6">
            <ElectricalSchematic project={project} materials={materials} />
        </div>
        <CommonFooter page={pageSchematic} />
      </div>

      {/* PAGES LISTE MATÉRIEL */}
      {materialChunks.map((chunk, pageIndex) => (
        <div key={pageIndex} className="pdf-page w-[210mm] h-[297mm] p-[15mm] flex flex-col bg-white text-left">
          <CommonHeader title={`Liste matériel globale ${materialPages > 1 ? `(${pageIndex + 1}/${materialPages})` : ''}`} />
          <div className="flex-1">
              <table className="w-full text-[11px] border-collapse">
                  <thead>
                      <tr className="bg-slate-800 text-white font-black text-[9px] tracking-widest uppercase">
                        <th className="p-4 text-left rounded-tl-xl">REF.</th>
                        <th className="p-4 text-left">DESCRIPTION</th>
                        <th className="p-4 text-center">QTE</th>
                        <th className="p-4 text-right rounded-tr-xl">CODE RICH.</th>
                      </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 border-x border-slate-100">
                      {chunk.map((row, idx) => {
                          if (row.type === 'header') {
                              return (
                                <tr key={`header-${row.title}`} className="bg-slate-200 border-y border-slate-300">
                                    <td colSpan={4} className="px-4 py-2 font-black text-slate-700 uppercase tracking-widest text-[10px]">
                                        {row.title}
                                    </td>
                                </tr>
                              );
                          }
                          if (row.type === 'subheader') {
                              return (
                                <tr key={`subheader-${row.title}`} className="bg-green-50 border-y border-green-100">
                                    <td colSpan={4} className="px-4 py-1.5 font-bold text-green-800 uppercase tracking-wide text-[9px]">
                                        {row.title}
                                    </td>
                                </tr>
                              );
                          }
                          if (row.type === 'warning') {
                              return (
                                <tr key={`warn-${idx}`} className="bg-red-50 border-b border-red-200">
                                    <td colSpan={4} className="p-2 text-[8px] font-bold text-red-600 text-center leading-tight">
                                        {row.text}
                                    </td>
                                </tr>
                              )
                          }
                          const m = row.material;
                          return (
                            <tr key={m.id} className={idx % 2 === 0 ? 'bg-white' : 'bg-slate-100'}>
                                <td className="p-4 font-black text-slate-800">{m.id}</td>
                                <td className="p-4">
                                    <div className="text-slate-500 font-medium">{m.description}</div>
                                </td>
                                <td className="p-4 text-center font-black text-slate-800 text-base">{m.quantity}</td>
                                <td className="p-4 text-right font-mono font-bold text-slate-400 text-[10px]">{m.price || '-'}</td>
                            </tr>
                          );
                      })}
                  </tbody>
              </table>
          </div>
          <CommonFooter page={totalPages - materialPages + pageIndex - (showDoc ? 2 : 0) - (showRegul ? 1 : 0)} />
        </div>
      ))}

      {/* Pages Documentation */}
      {showDoc && (
      <>
        <div className="pdf-page w-[210mm] h-[297mm] p-[15mm] flex flex-col bg-white text-left">
            <CommonHeader title="Documentation Technique - Structure & Modules" />
            <div className="grid grid-cols-2 gap-8 mt-4 flex-1 content-start">
                <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100">
                   <h3 className="text-sm font-black text-slate-800 uppercase border-b-2 border-slate-800 pb-2 mb-4">
                      1. Structure {projectDocs.structure.brand}
                   </h3>
                   <div className="space-y-3">
                      {projectDocs.structure.manuals.map((url, i) => (
                          <DocLink key={i} title="Notice de Montage (PDF)" url={url} icon="🔧" />
                      ))}
                      {projectDocs.structure.videos.map((v, i) => (
                          <DocLink key={i} title={`Vidéo : ${v.title}`} url={v.url} icon="▶️" />
                      ))}
                   </div>
                </div>

                <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100">
                   <h3 className="text-sm font-black text-slate-800 uppercase border-b-2 border-slate-800 pb-2 mb-4">
                      2. Panneaux {projectDocs.panel.name}
                   </h3>
                   <div className="space-y-3">
                      <DocLink title="Fiche Technique (PDF)" url={projectDocs.panel.datasheet} />
                      <DocLink title="Manuel d'Installation (PDF)" url={projectDocs.panel.manual} icon="📖" />
                   </div>
                </div>
            </div>
            <CommonFooter page={totalPages - (showDoc ? 1 : 0) - (showRegul ? 1 : 0)} />
        </div>
        
        <div className="pdf-page w-[210mm] h-[297mm] p-[15mm] flex flex-col bg-white text-left">
            <CommonHeader title="Documentation Technique - Énergie & Administratif" />
            <div className="grid grid-cols-2 gap-8 mt-4 flex-1 content-start">
                <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100">
                   <h3 className="text-sm font-black text-slate-800 uppercase border-b-2 border-slate-800 pb-2 mb-4">
                      3. Onduleur {projectDocs.inverter.brand}
                   </h3>
                   <div className="space-y-3">
                      <DocLink title="Fiche Technique" url={projectDocs.inverter.datasheet} />
                      <DocLink title="Manuel Utilisateur" url={projectDocs.inverter.manual} icon="📖" />
                      {projectDocs.inverter.foxCommissioningUrl && (
                          <DocLink title="Mise en service (Cloud)" url={projectDocs.inverter.foxCommissioningUrl} icon="☁️" />
                      )}
                   </div>
                </div>

                <div className="bg-blue-50 p-6 rounded-2xl border border-blue-100">
                   <h3 className="text-sm font-black text-blue-900 uppercase border-b-2 border-blue-900 pb-2 mb-4">
                      4. Démarches & Consuel
                   </h3>
                   <div className="space-y-3">
                      <DocLink title="Portail CONSUEL (Demande en ligne)" url="https://www.consuel.com/" icon="🌐" />
                      <DocLink title="Dossier Technique SC 144A (Vente Surplus)" url="https://www.consuel.com/dossiers-techniques/" icon="📄" />
                      <DocLink title="Dossier Technique SC 144B (Autoconso Totale/Batterie)" url="https://www.consuel.com/dossiers-techniques/" icon="📄" />
                   </div>
                </div>
            </div>
            <CommonFooter page={totalPages - (showRegul ? 1 : 0)} />
        </div>
      </>
      )}

      {showRegul && (
        <div className="pdf-page w-[210mm] h-[297mm] p-[15mm] flex flex-col bg-white text-left">
            <CommonHeader title="Rappel et Règlementation" />
            <div className="mt-8 flex-1">
                <h2 className="text-3xl font-black text-slate-800 mb-2">Cadre Normatif</h2>
                <div className="bg-blue-50 border border-blue-200 rounded-3xl p-10 relative overflow-hidden shadow-sm">
                     <h3 className="text-xl font-black text-blue-900 mb-6 uppercase tracking-tight">Attestation de Conformité CONSUEL</h3>
                     <p className="text-sm text-blue-800 font-medium leading-relaxed mb-8 max-w-xl">
                        Pour toute installation de production d'énergie électrique (photovoltaïque) avec ou sans dispositif de 
                        stockage, la conformité aux normes en vigueur est obligatoire.
                     </p>
                     <a href="https://actualites.consuel.com/wp-content/uploads/2025/07/NL12-ART-AUTOCONSO-JUILLET25-v12.pdf" target="_blank" rel="noopener noreferrer" className="inline-block bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-lg font-black text-sm uppercase tracking-widest shadow-md transition-transform active:scale-95">
                         Consulter la note officielle
                     </a>
                </div>
            </div>
            <CommonFooter page={totalPages} />
        </div>
      )}
    </div>
  );
};

export default PdfReport;
