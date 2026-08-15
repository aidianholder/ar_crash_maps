-- 01b_transform.sql — cast staging text into the typed `crashes` table.
-- Empty strings -> NULL; Yes/No -> boolean; builds a 4326 point geometry.
DROP TABLE IF EXISTS crashes;
CREATE TABLE crashes (
    objectid                 integer PRIMARY KEY,
    statecasenumber          text,
    localcasenumber          text,
    crashdate                date,
    crashtime                text,           -- mixed "11:40 AM" / "20:20:00" in source
    year                     integer,
    month                    text,
    dayofweek                text,
    mpo                      text,
    county                   text,
    city                     text,
    crashseverity            text,
    asp_troop                text,
    agencyname               text,
    intersectingstreetname   text,
    intersectingstreetroute  text,
    latitude                 double precision,
    longitude                double precision,
    ah_roadid                text,
    ah_logmile               double precision,
    numserinj                integer,
    numfatalities            integer,
    ruralurbanarea           text,
    lightingconditions       text,
    roadwaysurfaceconidtion  text,
    crashmanner              text,
    roadsystem               text,
    speedrelated             boolean,
    workzonerelated          boolean,
    roadwaydeparturerelated  boolean,
    intersectionrelated      boolean,
    unrestrainedrelated      boolean,
    impairedrelated          boolean,
    nonmotoristrelated       boolean,
    nonmotoristtype          text,
    cmvrelated               boolean,
    motorcyclerelated        boolean,
    globalid                 text,
    geom                     geometry(Point, 4326)
);

INSERT INTO crashes
SELECT
    NULLIF(objectid,'')::integer,
    NULLIF(statecasenumber,''),
    NULLIF(localcasenumber,''),
    NULLIF(crashdate,'')::date,
    NULLIF(crashtime,''),
    NULLIF(year,'')::integer,
    NULLIF(month,''), NULLIF(dayofweek,''), NULLIF(mpo,''), NULLIF(county,''),
    NULLIF(city,''), NULLIF(crashseverity,''), NULLIF(asp_troop,''), NULLIF(agencyname,''),
    NULLIF(intersectingstreetname,''), NULLIF(intersectingstreetroute,''),
    NULLIF(latitude,'')::double precision,
    NULLIF(longitude,'')::double precision,
    NULLIF(ah_roadid,''),
    NULLIF(ah_logmile,'')::double precision,
    NULLIF(numserinj,'')::integer,
    NULLIF(numfatalities,'')::integer,
    NULLIF(ruralurbanarea,''), NULLIF(lightingconditions,''), NULLIF(roadwaysurfaceconidtion,''),
    NULLIF(crashmanner,''), NULLIF(roadsystem,''),
    NULLIF(speedrelated,'')            = 'Yes',
    NULLIF(workzonerelated,'')         = 'Yes',
    NULLIF(roadwaydeparturerelated,'') = 'Yes',
    NULLIF(intersectionrelated,'')     = 'Yes',
    NULLIF(unrestrainedrelated,'')     = 'Yes',
    NULLIF(impairedrelated,'')         = 'Yes',
    NULLIF(nonmotoristrelated,'')      = 'Yes',
    NULLIF(nonmotoristtype,''),
    NULLIF(cmvrelated,'')              = 'Yes',
    NULLIF(motorcyclerelated,'')       = 'Yes',
    NULLIF(globalid,''),
    CASE WHEN NULLIF(longitude,'') IS NOT NULL AND NULLIF(latitude,'') IS NOT NULL
         THEN ST_SetSRID(ST_MakePoint(longitude::double precision, latitude::double precision), 4326)
    END
FROM crashes_staging;

CREATE INDEX crashes_geom_gix     ON crashes USING gist (geom);
CREATE INDEX crashes_crashdate_idx ON crashes (crashdate);
CREATE INDEX crashes_county_idx    ON crashes (county);

DROP TABLE crashes_staging;
ANALYZE crashes;
